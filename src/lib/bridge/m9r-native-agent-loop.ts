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
 * through the audited registry (m9r-native-provider-registry.ts). The five
 * governed file/repo tools plus send_message are wired; search_memory,
 * draft_section, and the evidence/task-contract tools are a real, honest
 * gap for a later pass -- not silently included, not claimed as done.
 */
import { z } from "zod";
import { tool, stepCountIs, streamText, type ModelMessage, type ToolSet, type LanguageModel } from "ai";
import { getWorkspaceProviderEnv } from "@/lib/mission/m9r-native-credential-service";
import { findProvidersForModel } from "@/lib/mission/m9r-native-model-catalog";
import { resolveCatalogModel, CANONICAL_PROVIDER_IDS } from "@/lib/bridge/m9r-native-provider-registry";
import {
  readGovernedFile,
  strReplaceGovernedFile,
  listGovernedTree,
  ripgrepSearch,
  gitRead,
  postAgentMessage,
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

/** Shared tool construction -- the one place read_file/str_replace/tree/rg/git_read/send_message get wired to the AI SDK's `tool()` shape, used by both the drain-to-completion entry point and the streaming one below so they can never drift apart. */
function buildTools(root: string, channel: M9rNativeLoopChannel | undefined, emit: (event: M9rNativeActivityEvent) => void): ToolSet {
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
    git_read: tool({
      description: "Check repository state without changing it. Use this to understand the current branch, recent commits, or local diff before reporting work; the allowed operations are status, log, diff_stat, and branch.",
      inputSchema: z.object({
        operation: z.enum(["status", "log", "diff_stat", "branch"]),
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
  const tools = buildTools(input.workingDirectory, input.channel, () => {});
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
  const tools = buildTools(input.workingDirectory, input.channel, (event) => activityQueue.push(event));
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
