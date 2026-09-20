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
import { renderInboxInjection, renderSentAck, renderSessionCard, MAX_GOAL_CHARS } from "./inbox-core";
import { findEndpointMentions } from "./mention-core";
import { findMemoryHints, renderMemoryHint } from "./memory-hint-core";
import { handleForProvider, type LocalStore } from "./local-store";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
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
  return prompt.replace(new RegExp(`@${handle}\\b`, "gi"), "").replace(/[ \t]{2,}/g, " ").trim();
}

function readMemoryIndex(cwd: string): string | null {
  try {
    const path = join(cwd, ".oathlock", "memory", "index.md");
    return statSync(path).size <= 96_000 ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
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
      return out(event, renderSessionCard({ handle: self, others, pendingCount: pending, memoryDir }));
    }

    if (event === "UserPromptSubmit") {
      const prompt = input.prompt ?? "";
      ctx.store.registerEndpoint({ provider: ctx.provider, sessionId: input.session_id, cwd: input.cwd });
      const cwd = input.cwd ?? process.cwd();
      const exists = ctx.pathExists ?? existsSync;
      const parts: string[] = [];

      // 1. Human-typed mentions become tasks. Never our own handle; never an existing file or folder.
      const targets = findEndpointMentions(prompt, {
        aliases: ctx.store.knownAliases().filter((a) => a !== self),
        pathExists: (token) => exists(resolve(join(cwd, token))),
      });
      for (const to of targets) {
        const goal = goalFor(prompt, to);
        if (!goal) continue;
        const { task } = ctx.store.addTask({ from: self, to, goal: goal.slice(0, MAX_GOAL_CHARS * 2), origin: "human_typed", idempotencyKey: sha(`${input.session_id ?? ""}|${to}|${prompt}`) });
        parts.push(renderSentAck(task.id, to));
      }

      // 2. Anything new in our own inbox, delta-only.
      const cursor = ctx.store.cursorFor(self, input.session_id);
      const injection = renderInboxInjection(ctx.store.tasksFor(self), cursor);
      if (injection.text) {
        parts.push(injection.text);
        ctx.store.setCursor(self, input.session_id, injection.newCursor);
        ctx.store.markDelivered(injection.includedIds);
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
