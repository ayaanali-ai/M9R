/**
 * What the installed hook does for each agent event (design sections 5, 6 and 9). Takes the parsed hook input and a
 * store, returns the JSON the hook prints, or null to print nothing (an idle hook costs zero tokens).
 *
 * Contract with the agents (verified 2026-09-20 on Claude Code and Codex): `UserPromptSubmit` and `SessionStart` may
 * print `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}`.
 *
 * Fails silent by design: a broken M9R must never block, slow or pollute someone's prompt.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { renderInboxInjection, renderResultsInjection, renderSentAck, renderSessionCard, MAX_GOAL_CHARS } from "./inbox-core";
import { canQueue, isM9rPushedPrompt } from "./codex-delivery-core";
import { findEndpointMentions } from "./mention-core";
import { findMemoryHints, renderMemoryHint } from "./memory-hint-core";
import { handleForProvider, type LocalStore } from "./local-store";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
}

export interface HookContext {
  provider: string;
  store: LocalStore;
  /** Where shared memory lives, shown in the session card. */
  memoryDir?: string;
  pathExists?: (absolutePath: string) => boolean;
  /** Returns the text of the project's memory index, or null. Injected for tests; the default reads it with a size cap. */
  readIndex?: (cwd: string) => string | null;
  /** N2: starts pushing a task into the target Codex session (fire and forget; the hook never waits for Codex). */
  dispatch?: (taskId: string) => void;
  /** N2: reads back answers for tasks already pushed into Codex sessions, before results are shown. */
  collect?: () => void;
  /** The final message of this agent's just-finished turn (from its transcript); used to answer tasks it was shown. */
  lastAnswer?: (input: HookInput) => string | null;
  /** A task just got its answer: send it back to whoever asked (fire and forget). */
  answerBack?: (taskId: string) => void;
  /** Endpoints seen more recently than this count as "active now" on the card. */
  activeWindowMs?: number;
  now?: () => Date;
}

type AdditionalContext = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

const out = (event: string, text: string): AdditionalContext | null =>
  text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** The task's goal is what the human wrote, minus the routing token, so the target reads a clean request. */
function goalFor(prompt: string, handle: string): string {
  // Claude Code wraps pasted text in <pasted_content ...> tags; they are not part of what the person asked.
  return prompt.replace(/<\/?pasted_content[^>]*>/gi, " ").replace(new RegExp(`@${handle}\\b`, "gi"), "").replace(/[ \t]{2,}/g, " ").trim();
}

function readMemoryIndex(cwd: string): string | null {
  try {
    const path = join(cwd, ".oathlock", "memory", "index.md");
    return statSync(path).size <= 96_000 ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Human-typed mentions become tasks. Never our own handle; never an existing file or folder. Shared by the hook and the
 * hook-free Codex watcher, and does nothing else (no inbox, no results), so the watcher can call it without side effects on Codex.
 * Returns the "sent" acknowledgements the hook shows to the agent.
 */
export function routeTypedMentions(input: HookInput, ctx: Pick<HookContext, "provider" | "store" | "pathExists" | "dispatch">): { acks: string[]; tasks: Array<{ id: string; to: string }> } {
  const self = handleForProvider(ctx.provider);
  const prompt = input.prompt ?? "";
  const cwd = input.cwd ?? process.cwd();
  const exists = ctx.pathExists ?? existsSync;
  const acks: string[] = [];
  const tasks: Array<{ id: string; to: string }> = [];
  ctx.store.registerEndpoint({ provider: ctx.provider, sessionId: input.session_id, cwd: input.cwd });
  // A prompt M9R pushed in ("[M9R T3] Task from @claude ...") names its sender; routing that would bounce it back.
  const targets = isM9rPushedPrompt(prompt) ? [] : findEndpointMentions(prompt, {
    aliases: ctx.store.knownAliases().filter((a) => a !== self),
    pathExists: (token) => exists(resolve(join(cwd, token))),
  });
  for (const to of targets) {
    const goal = goalFor(prompt, to);
    if (!goal) continue;
    const { task, created } = ctx.store.addTask({ from: self, to, goal: goal.slice(0, MAX_GOAL_CHARS * 2), origin: "human_typed", cwd: input.cwd, fromSession: input.session_id, idempotencyKey: sha(`${input.session_id ?? ""}|${to}|${prompt}`) });
    acks.push(renderSentAck(task.id, to));
    tasks.push({ id: task.id, to });
    if (created && to === "codex" && canQueue(task)) ctx.dispatch?.(task.id);
  }
  return { acks, tasks };
}

export function handleHookEvent(input: HookInput, ctx: HookContext): AdditionalContext | null {
  try {
    const event = input.hook_event_name ?? "";
    const self = handleForProvider(ctx.provider);
    const now = (ctx.now ?? (() => new Date()))();
    const activeWindow = ctx.activeWindowMs ?? 10 * 60_000;

    if (event === "SessionStart") {
      ctx.store.registerEndpoint({ provider: ctx.provider, sessionId: input.session_id, cwd: input.cwd });
      const others = ctx.store.listEndpoints().filter((e) => e.handle !== self && now.getTime() - Date.parse(e.lastSeenAt) < activeWindow).map((e) => ({ handle: e.handle }));
      const pending = renderInboxInjection(ctx.store.tasksFor(self), ctx.store.cursorFor(self, input.session_id)).includedIds.length;
      // Only mention memory if the index file really exists here (the earlier card pointed at a file that did not).
      const memoryDir = ctx.memoryDir ?? (input.cwd && (ctx.pathExists ?? existsSync)(join(input.cwd, ".oathlock", "memory", "index.md")) ? ".oathlock/memory" : undefined);
      ctx.store.sweepExpired();
      const awaitingApproval = ctx.store.pendingApprovals().length;
      const identityToken = input.session_id ? ctx.store.issueIdentity(self, ctx.provider, input.session_id).token : undefined;
      return out(event, renderSessionCard({ handle: self, others, pendingCount: pending, awaitingApproval, memoryDir, identityToken }));
    }

    // A turn finished. If this session was shown tasks other agents sent, its final message is the answer: record it and send it back.
    if (event === "Stop") {
      const waiting = ctx.store.awaitingAnswerFrom(self, input.session_id);
      if (waiting.length === 0 || !ctx.lastAnswer) return null;
      const text = ctx.lastAnswer(input);
      if (!text) return null;
      for (const t of waiting) {
        ctx.store.setResult(t.id, text);
        ctx.answerBack?.(t.id);
      }
      return null;
    }

    if (event === "UserPromptSubmit") {
      const prompt = input.prompt ?? "";
      const cwd = input.cwd ?? process.cwd();
      const parts: string[] = [];

      parts.push(...routeTypedMentions(input, ctx).acks);

      // A prompt M9R pushed in is a task by itself: nothing else (older inbox items, results) is mixed into it, or the agent
      // may answer the wrong one. Those items wait for the user's next real prompt.
      if (isM9rPushedPrompt(prompt)) return out(event, parts.join("\n"));

      // 2a. Answers to tasks we sent, once.
      try { ctx.collect?.(); } catch { /* a collect failure must never touch the prompt */ }
      const results = renderResultsInjection(ctx.store.tasksFrom(self), self);
      if (results.text) { parts.push(results.text); ctx.store.markResultShown(results.ids); }

      // 2b. Anything new in our own inbox, delta-only.
      const cursor = ctx.store.cursorFor(self, input.session_id);
      const injection = renderInboxInjection(ctx.store.tasksFor(self), cursor);
      if (injection.text) {
        parts.push(injection.text);
        ctx.store.setCursor(self, input.session_id, injection.newCursor);
        ctx.store.markDelivered(injection.includedIds, input.session_id);
      }

      // 3. A pointer to earlier sessions, only when this prompt matches the local memory index.
      const hint = renderMemoryHint(findMemoryHints(prompt, (ctx.readIndex ?? readMemoryIndex)(cwd) ?? ""));
      if (hint) parts.push(hint);
      return out(event, parts.join("\n"));
    }

    return null;
  } catch {
    return null;
  }
}
