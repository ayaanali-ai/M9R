/**
 * Item #32 phase 2: M9R's own agent loop -- the actual thing OpenCode/Aider/
 * Cursor each built. Given a user turn, decide which tools to call, call
 * them, feed results back to the model, repeat until a final answer.
 *
 * This is the piece that makes "agents can still talk to each other" true
 * by construction: `send_message` here calls the exact same
 * `postAgentMessage` function (governed-agent-tools.ts) that Claude Code,
 * Codex, and OpenCode's MCP-wrapped `send_message` calls -- same route,
 * same idempotency-key posture, same reply shape. The relay and every other
 * agent cannot tell which provider/adapter sent a message, because nothing
 * about how messages get posted changed. This loop just calls that function
 * in-process instead of through an MCP subprocess, since the harness IS the
 * process (no separate CLI binary to talk to over a protocol the way the
 * three ACP-driven providers need).
 *
 * Provider resolution is catalog-driven (m9r-native-model-catalog.ts, the
 * real models.dev data), not a hand-typed list -- given any model id, the
 * loop looks up which real provider serves it and resolves a language model
 * through the audited registry (m9r-native-provider-registry.ts). The native
 * loop exposes the same governed file/repo, collaboration, evidence, and
 * task-contract surface as the provider MCP server. Unrestricted shell
 * execution remains intentionally absent; a provider may still report that
 * a runtime such as Python is unavailable.
 */
import { z } from "zod";
import { tool, stepCountIs, streamText, type ModelMessage, type ToolSet, type LanguageModel } from "ai";
import { getWorkspaceProviderEnv } from "@/lib/mission/m9r-native-credential-service";
import { findProvidersForModel } from "@/lib/mission/m9r-native-model-catalog";
import { resolveCatalogModel, CANONICAL_PROVIDER_IDS } from "@/lib/bridge/m9r-native-provider-registry";
import { CHAT_EVIDENCE_SCHEMA_VERSION } from "@/lib/bridge/chat-evidence-schema";
import { TERMINAL_ENABLED } from "@/lib/terminal-config";
import {
  readGovernedFile,
  createGovernedFile,
  strReplaceGovernedFile,
  listGovernedTree,
  ripgrepSearch,
  gitRead,
  GIT_READ_OPERATIONS,
  redactGovernedToolCredential,
  postAgentMessage,
  todoAction,
  type TodoItem,
  type GitReadOperation,
} from "@/lib/bridge/governed-agent-tools";

/**
 * Real, provider-agnostic activity event shape -- deliberately mirrors
 * acp-stdio-adapter.ts's own `ActivityPayload` (activityKind file.read/
 * file.changed/command.started/command.completed, etc.) so this harness's
 * activity reaches the exact same downstream consumers (workspace activity
 * stream, the "eyes" cross-agent awareness note) without a second shape to
 * translate.
 */
export interface M9rNativeActivityEvent {
  activityKind: "file.read" | "file.changed" | "command.started" | "command.completed" | "message.posted";
  summary: string;
  filePath?: string | null;
  command?: string | null;
}

/**
 * The progressive event shape `prompt()`'s async generator yields --
 * distinct from `InteractiveProviderEvent` (interactive-provider-adapter.ts)
 * because that type is generic across all four adapters; the adapter itself
 * (m9r-native-provider-adapter.ts) wraps these into the real
 * `InteractiveProviderEvent` envelope (adding sessionId/occurredAt/turnId).
 * Kept separate here so this file has no dependency on the adapter
 * interface's types, matching the same separation acp-stdio-adapter.ts
 * keeps between its own event handling and the interface it implements.
 */
export type M9rNativeTurnEvent =
  | { type: "text-delta"; text: string }
  | { type: "activity"; activity: M9rNativeActivityEvent }
  | { type: "finish"; text: string; steps: number }
  | { type: "error"; message: string };

export interface M9rNativeLoopChannel {
  appUrl: string;
  agentToken: string;
  missionId: string;
}

/** Model instance cache, keyed on npm-package+apiKey+model -- same pattern confirmed against sst/opencode's real production code (see m9r-native-model-client.ts's own comment on this). Keying on the api key itself means a rotated credential naturally gets a fresh instance, no explicit invalidation needed. */
const modelCache = new Map<string, LanguageModel>();

/**
 * Real, catalog-driven resolution: given a model id, finds which real
 * provider(s) (models.dev) serve it, resolves a credential (checking every
 * env var name the catalog says that provider accepts, since a couple of
 * providers declare more than one), and builds a real language model through
 * the audited registry.
 *
 * A model id is NOT globally unique in the real catalog -- checked live,
 * not assumed: reseller/proxy providers (e.g. a "Modelis" entry) can list a
 * model under the exact same id string as its canonical first-party
 * provider (e.g. "anthropic"'s "claude-sonnet-4-6"). Picking whichever one
 * a naive first-match iteration happens to hit first is wrong and
 * non-deterministic (it depends on the catalog JSON's own key order).
 * Instead: check every provider that lists this model id, prefer the one
 * this workspace actually has a stored credential for (that is real,
 * unambiguous consent -- the workspace chose to add that specific
 * provider's key), and only fall back to an uncredentialed candidate for
 * the final, honest "no credential stored" error message when none of them
 * have one.
 */
export async function resolveModelForTurn(workspaceId: string, model: string): Promise<LanguageModel> {
  const candidates = await findProvidersForModel(model);
  if (candidates.length === 0) throw new Error(`"${model}" isn't a model M9R's provider catalog knows about.`);

  const workspaceEnv = await getWorkspaceProviderEnv(workspaceId);
  const withCredential = candidates.find((provider) => provider.env.some((name) => workspaceEnv[name]));
  const canonical = candidates.find((provider) => CANONICAL_PROVIDER_IDS.has(provider.id));
  const provider = withCredential ?? canonical ?? candidates[0];

  const cacheKey = `${provider.npm}:${provider.id}:${model}`;
  const envName = provider.env.find((name) => workspaceEnv[name]);
  if (!envName) {
    throw new Error(`No ${provider.name} credential is stored for this workspace. Add one (${provider.env.join(" or ")}) before using this model through M9R's own harness.`);
  }
  const apiKey = workspaceEnv[envName]!;
  const fullCacheKey = `${cacheKey}:${apiKey}`;
  const cached = modelCache.get(fullCacheKey);
  if (cached) return cached;

  const languageModel = resolveCatalogModel({ npm: provider.npm, apiKey, baseURL: provider.api, providerId: provider.id, model });
  modelCache.set(fullCacheKey, languageModel);
  return languageModel;
}

/** Bounds how many tool-call/response round trips one turn can take -- a real cap, not an accident. Same category of protection as the reply-depth cap already built for agent-to-agent messages: an agent loop that never stops calling tools is a real, observed failure mode elsewhere in this codebase, not a hypothetical. */
const MAX_TURN_STEPS = 24;

function channelConversationId(channel: M9rNativeLoopChannel): string | null {
  return channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null;
}

async function channelRequest(channel: M9rNativeLoopChannel, path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${channel.appUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${channel.agentToken}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    throw new Error(`M9R channel request failed: ${redactGovernedToolCredential(detail, channel.agentToken).slice(0, 300)}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`M9R channel request failed (HTTP ${response.status}): ${redactGovernedToolCredential(detail, channel.agentToken).slice(0, 300)}`);
  }
  const body = await response.text().catch(() => "");
  try {
    return JSON.parse(redactGovernedToolCredential(body, channel.agentToken)) as unknown;
  } catch {
    return {};
  }
}

/** Shared tool construction -- the one place all governed tools get wired to the AI SDK's `tool()` shape, used by both turn entry points so they can never drift apart. */
export function buildM9rNativeTools(root: string, channel: M9rNativeLoopChannel | undefined, emit: (event: M9rNativeActivityEvent) => void): ToolSet {
  const todos: TodoItem[] = [];
  return {
    read_file: tool({
      description: "Read a UTF-8 text file in the assigned working directory. Use this when you need to inspect existing code or documentation before making a decision. Paths outside the directory and files over 10MB are refused.",
      inputSchema: z.object({ path: z.string().describe("The file to inspect, as an absolute path or a path relative to the working directory.") }),
      execute: async ({ path }) => {
        const text = await readGovernedFile(root, path);
        emit({ activityKind: "file.read", summary: `Read ${path}`, filePath: path });
        return text;
      },
    }),
    create_file: tool({
      description: "Create one new UTF-8 text file inside the assigned working directory. Existing files are never overwritten; read and edit them with str_replace instead.",
      inputSchema: z.object({ path: z.string(), content: z.string().max(10 * 1024 * 1024) }),
      execute: async ({ path, content }) => {
        const result = await createGovernedFile(root, path, content);
        emit({ activityKind: "file.changed", summary: `Created ${path}`, filePath: path });
        return result;
      },
    }),
    str_replace: tool({
      description: "Make one precise edit in a file in the assigned working directory. Use this only after reading the file and include enough oldText to identify exactly one intended location.",
      inputSchema: z.object({
        path: z.string(),
        oldText: z.string().describe("The exact existing text to replace; it must occur once, never zero or multiple times."),
        newText: z.string(),
      }),
      execute: async ({ path, oldText, newText }) => {
        const result = await strReplaceGovernedFile(root, path, oldText, newText);
        emit({ activityKind: "file.changed", summary: `Edited ${path}`, filePath: path });
        return result;
      },
    }),
    tree: tool({
      description: "Get your bearings in the assigned working directory. Use this before searching when you do not yet know where the relevant files live; the result is bounded and excludes dependency and Git internals.",
      inputSchema: z.object({ path: z.string().default("."), maxDepth: z.number().int().min(1).max(8).default(3) }),
      execute: async ({ path, maxDepth }) => listGovernedTree(root, path, maxDepth),
    }),
    rg: tool({
      description: "Find relevant code or text in the assigned working directory. Prefer this over guessing filenames, then read the strongest matches before acting.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().default("."),
        caseInsensitive: z.boolean().default(false),
        maxMatches: z.number().int().min(1).max(500).default(200),
      }),
      execute: async ({ pattern, path, caseInsensitive, maxMatches }) => ripgrepSearch(root, pattern, path, caseInsensitive, maxMatches),
    }),
    todo: tool({
      description: "Keep a bounded checklist for active work in this session. Use list, add, or complete, and only close items after verification.",
      inputSchema: z.object({ action: z.enum(["list", "add", "complete"]), text: z.string().optional(), id: z.string().optional() }),
      execute: async ({ action, text, id }) => todoAction(todos, action, text, id),
    }),
    git_read: tool({
      description: "Check repository state without changing it. Use this to understand the current branch, recent commits, or local diff before reporting work; the allowed operations are status, log, diff_stat, and branch.",
      inputSchema: z.object({
        operation: z.enum(GIT_READ_OPERATIONS),
        limit: z.number().int().min(1).max(20).default(1),
      }),
      execute: async ({ operation, limit }) => {
        const result = await gitRead(root, operation as GitReadOperation, limit);
        emit({ activityKind: "command.completed", summary: `git ${operation}`, command: operation });
        return result;
      },
    }),
    ...(channel ? {
      send_message: tool({
        description:
          "Say something useful to the people and agents in this Mission's channel. Use this for a real handoff, a direct answer, or a meaningful progress or verification update; write it like a concise teammate, not a log line. Mention another provider only when you want that agent to act, and do not post every minor step.",
        inputSchema: z.object({
          text: z.string().min(1).max(2_000),
          parentMessageId: z.string().min(1).max(200).optional(),
          recipientConnectionId: z.string().min(1).max(200).optional(),
        }),
        execute: async ({ text, parentMessageId, recipientConnectionId }) => {
          const result = await postAgentMessage(channel, { text, parentMessageId, recipientConnectionId });
          emit({ activityKind: "message.posted", summary: "Posted a message to the channel." });
          return result;
        },
      }),
      search_memory: tool({
        description: "Search archived workspace sessions for prior decisions and verified context before starting unfamiliar work.",
        inputSchema: z.object({ query: z.string().max(160).default(""), limit: z.number().int().min(1).max(25).default(8) }),
        execute: async ({ query, limit }) => {
          const params = new URLSearchParams({ q: query, limit: String(limit) });
          const body = await channelRequest(channel, `/api/agent/memory/search?${params.toString()}`) as {
            matches?: Array<{ title: string; ownerLabel: string; conversationTopic: string; archivedAtMs: number | null; transcript: Array<{ sender: string; body: string }> }>;
          };
          const matches = body.matches ?? [];
          if (matches.length === 0) return "No past sessions matched.";
          return matches.map((match) => {
            const when = match.archivedAtMs ? new Date(match.archivedAtMs).toISOString() : "unknown time";
            const excerpt = match.transcript.map((line) => `  ${line.sender}: ${line.body}`).join("\n") || "  (no transcript captured)";
            return `## ${match.title}\nOwner: ${match.ownerLabel} · Channel: #${match.conversationTopic} · Archived: ${when}\n${excerpt}`;
          }).join("\n\n");
        },
      }),
      draft_section: tool({
        description: "Write or revise one named section of a shared draft document in this channel. Use prose, not raw code or diffs.",
        inputSchema: z.object({ draftTitle: z.string().min(1).max(200), heading: z.string().min(1).max(120), body: z.string().min(1).max(8_000) }),
        execute: async ({ draftTitle, heading, body }) => {
          const conversationId = channelConversationId(channel);
          if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to write this draft.");
          await channelRequest(channel, `/api/agent/conversations/${encodeURIComponent(conversationId)}/drafts`, { method: "POST", body: JSON.stringify({ draftTitle, heading, body }) });
          return `Wrote "${heading}" in "${draftTitle}".`;
        },
      }),
      request_evidence_review: tool({
        description: "Ask the human to review completed work before submitting structured evidence. Wait for explicit approval.",
        inputSchema: z.object({ summary: z.string().min(1).max(500) }),
        execute: async ({ summary }) => {
          const conversationId = channelConversationId(channel);
          if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to request evidence review.");
          const body = await channelRequest(channel, `/api/agent/conversations/${encodeURIComponent(conversationId)}/evidence/requests`, { method: "POST", body: JSON.stringify({ summary }) }) as { id?: string };
          return `Evidence review requested. Wait for explicit human approval, then call submit_evidence with requestId ${body.id ?? "returned-by-the-server"}.`;
        },
      }),
      submit_evidence: tool({
        description: "Submit structured evidence only after the matching evidence request was explicitly approved in-channel.",
        inputSchema: z.object({
          requestId: z.string().min(1),
          evidence: z.object({
            schemaVersion: z.literal(CHAT_EVIDENCE_SCHEMA_VERSION),
            summary: z.string().min(1).max(500),
            work: z.array(z.string().min(1).max(1_000)).min(1).max(16),
            files: z.array(z.string().min(1).max(500)).max(32),
            verification: z.array(z.object({ command: z.string().min(1).max(500), result: z.string().min(1).max(1_000) })).min(1).max(16),
            limitations: z.array(z.string().min(1).max(1_000)).max(16),
          }).strict(),
        }),
        execute: async ({ requestId, evidence }) => {
          const conversationId = channelConversationId(channel);
          if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to submit this evidence.");
          await channelRequest(channel, `/api/agent/conversations/${encodeURIComponent(conversationId)}/evidence`, { method: "POST", body: JSON.stringify({ requestId, evidence }) });
          return "Structured evidence submitted for final human review in the channel.";
        },
      }),
      submit_task_split: tool({
        description: "Submit a one-time decomposition of a multi-agent request into directly assigned task-contract items.",
        inputSchema: z.object({
          conversationId: z.string().min(1).max(200).optional(),
          anchorMessageId: z.string().min(1).max(200).optional(),
          items: z.array(z.object({ description: z.string().min(1).max(2_000), expectedFilePaths: z.array(z.string().min(1).max(500)).max(50).optional(), assignedConnectionId: z.string().min(1).max(200) })).min(1).max(16),
        }),
        execute: async ({ conversationId, anchorMessageId, items }) => {
          const resolvedConversationId = conversationId ?? channelConversationId(channel);
          if (!resolvedConversationId) throw new Error("This Mission isn't bound to a chat channel, so there's no conversation to split work in.");
          const body = await channelRequest(channel, "/api/bridge/task-contracts", { method: "POST", body: JSON.stringify({ conversationId: resolvedConversationId, anchorMessageId, items }) }) as { dispatched?: number };
          return `Split submitted: ${items.length} item(s), ${body.dispatched ?? 0} agent(s) woken with their own piece.`;
        },
      }),
      update_task_item_status: tool({
        description: "Report progress or completion on a task-contract item assigned to this session.",
        inputSchema: z.object({ itemId: z.string().min(1).max(200), status: z.enum(["in_progress", "done", "failed"]), resultMessageId: z.string().min(1).max(200).optional() }),
        execute: async ({ itemId, status, resultMessageId }) => {
          await channelRequest(channel, `/api/bridge/task-contracts/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify({ status, resultMessageId }) });
          return `Item marked ${status}.`;
        },
      }),
      list_my_task_items: tool({
        description: "List active task-contract items assigned to this session across the workspace.",
        inputSchema: z.object({}),
        execute: async () => {
          const body = await channelRequest(channel, "/api/bridge/task-contracts") as { items?: Array<{ id: string; description: string; status: string }> };
          const items = body.items ?? [];
          return items.length === 0 ? "No active task-contract items assigned to you right now." : items.map((item) => `- ${item.id} [${item.status}]: ${item.description}`).join("\n");
        },
      }),
      request_assignment_change: tool({
        description: "Ask the human to change the assignment when the current task-contract item has the wrong scope, dependency, capability, or owner.",
        inputSchema: z.object({ itemId: z.string().min(1).max(200), reason: z.enum(["wrong_scope", "blocked_by_dependency", "outside_capability", "already_done_by_other", "needs_split"]), detail: z.string().min(1).max(600), suggestedConnectionId: z.string().optional() }),
        execute: async ({ itemId, reason, detail, suggestedConnectionId }) => {
          await channelRequest(channel, `/api/agent/task-contracts/items/${encodeURIComponent(itemId)}/change-request`, { method: "POST", body: JSON.stringify({ reason, detail, suggestedConnectionId }) });
          return "Assignment change requested and the item is now blocked. Stop work and wait for a human decision.";
        },
      }),
      ...(TERMINAL_ENABLED ? {
        handoff_to_terminal: tool({
          description: "Show a teammate a human-confirmed terminal handoff card; this never executes anything on their machine.",
          inputSchema: z.object({ targetSessionId: z.string().min(1).max(200), text: z.string().min(1).max(2_000), reason: z.string().max(300).optional() }),
          execute: async ({ targetSessionId, text, reason }) => {
            const conversationId = channelConversationId(channel);
            if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's no conversation to hand off within.");
            await channelRequest(channel, `/api/agent/conversations/${encodeURIComponent(conversationId)}/handoff-to-terminal`, { method: "POST", body: JSON.stringify({ targetSessionId, text, reason }) });
            return "Handed off. The teammate must click Send to terminal; nothing was executed.";
          },
        }),
      } : {}),
    } : {}),
  };
}

export interface M9rNativeTurnInput {
  workspaceId: string;
  workingDirectory: string;
  model: string;
  system?: string;
  prompt: string;
  channel?: M9rNativeLoopChannel;
  /** Real cancellation, not a stub -- the adapter's cancelTurn aborts this signal, which streamText honors natively. */
  abortSignal?: AbortSignal;
}

/**
 * Runs one full agent turn and returns only once it's finished -- the
 * simple entry point for a caller that just wants the final text (tests,
 * one-off calls). `runM9rNativeTurnStream` below is the progressive,
 * event-yielding version `M9rNativeProviderAdapter.prompt()` actually uses.
 */
export async function runM9rNativeTurn(input: M9rNativeTurnInput): Promise<{ text: string; steps: number }> {
  const languageModel = await resolveModelForTurn(input.workspaceId, input.model);
  const tools = buildM9rNativeTools(input.workingDirectory, input.channel, () => {});
  const messages: ModelMessage[] = [{ role: "user", content: input.prompt }];
  const result = streamText({
    model: languageModel,
    ...(input.system ? { system: input.system } : {}),
    messages,
    tools,
    stopWhen: stepCountIs(MAX_TURN_STEPS),
  });

  for await (const _chunk of result.textStream) {
    void _chunk;
  }
  const finalText = await result.text;
  const finishSteps = (await result.steps).length;
  return { text: finalText, steps: finishSteps };
}

/**
 * The real, progressive event stream: yields a `text-delta` as the model
 * streams its answer, an `activity` event each time a governed tool call
 * resolves, and a final `finish` (or `error`). This is what
 * `M9rNativeProviderAdapter.prompt()` wraps into real
 * `InteractiveProviderEvent`s for the relay/multiplayer layer to consume --
 * see that file for how these map onto session-update-shaped events.
 */
export async function* runM9rNativeTurnStream(input: M9rNativeTurnInput): AsyncGenerator<M9rNativeTurnEvent> {
  let languageModel: LanguageModel;
  try {
    languageModel = await resolveModelForTurn(input.workspaceId, input.model);
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    return;
  }

  const activityQueue: M9rNativeActivityEvent[] = [];
  const tools = buildM9rNativeTools(input.workingDirectory, input.channel, (event) => activityQueue.push(event));
  const messages: ModelMessage[] = [{ role: "user", content: input.prompt }];

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: languageModel,
      ...(input.system ? { system: input.system } : {}),
      messages,
      tools,
      stopWhen: stepCountIs(MAX_TURN_STEPS),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    return;
  }

  let finalText = "";
  try {
    for await (const part of result.fullStream) {
      // Tool activity resolves inside `execute`, synchronously ahead of the
      // stream part that reports it -- drain the queue before handling the
      // part itself so activity events reach the caller in the order the
      // real work happened, not the order the SDK reports it.
      while (activityQueue.length > 0) yield { type: "activity", activity: activityQueue.shift()! };

      if (part.type === "text-delta") {
        finalText += part.text;
        yield { type: "text-delta", text: part.text };
      } else if (part.type === "error") {
        yield { type: "error", message: part.error instanceof Error ? part.error.message : String(part.error) };
      } else if (part.type === "abort") {
        // A real cancelTurn (adapter aborts the signal passed in above) --
        // graceful stop, not a failure, so this reports as `finish` with
        // whatever text had already streamed, not `error`.
        while (activityQueue.length > 0) yield { type: "activity", activity: activityQueue.shift()! };
        yield { type: "finish", text: finalText, steps: (await result.steps).length };
        return;
      }
    }
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    return;
  }

  while (activityQueue.length > 0) yield { type: "activity", activity: activityQueue.shift()! };
  const steps = (await result.steps).length;
  yield { type: "finish", text: finalText, steps };
}
