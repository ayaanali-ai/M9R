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
import { inboxMaxAgeMs, renderHeldAck, renderInboxAck, renderInboxInjection, renderOpenCodePendingAck, renderResultsInjection, renderSentAck, renderSessionCard, MAX_GOAL_CHARS } from "./inbox-core";
import { buildQueueMessage, canQueue, isM9rPushedPrompt, isWindowsSystemCwd, normCwd } from "./codex-delivery-core";
import { findEndpointMentions } from "./mention-core";
import { findMemoryHints, renderMemoryHint } from "./memory-hint-core";
import { handleForProvider, type LocalStore } from "./local-store";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  /** OpenCode's generated plugin acknowledges a prompt only after its session API accepted and completed it. */
  task_id?: string;
  /** Fixed, non-sensitive delivery diagnostic; raw SDK errors and request bodies never cross this boundary. */
  delivery_error?: "session_rejected" | "unknown";
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
  /** Production routing fails visibly when a known target has no live M9R identity. */
  strictTargetIdentity?: boolean;
  /** Endpoints seen more recently than this count as "active now" on the card. */
  activeWindowMs?: number;
  now?: () => Date;
  /** This agent's turn just ended: tell the browser overlay so a stuck-on-last-action cursor can show "Done". Fire and forget. */
  /** Diagnostic hook for the unmodified provider payload at the moment a typed mention is routed. */
  captureMentionInput?: (input: HookInput, targets: readonly string[], rawPayload?: string) => void;
  /** Exact stdin bytes decoded as UTF-8 by m9r-hook, only forwarded to an explicit diagnostic capture. */
  rawPayload?: string;
}

type AdditionalContext = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

const out = (event: string, text: string): AdditionalContext | null =>
  text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/**
 * The installed broker and hook entrypoints live under the per-user M9R home
 * (normally ~/.m9r).  A provider can inherit that folder as process.cwd()
 * when M9R launches it, but that is install state, never the user's project.
 * Keep that path out of task/session routing; a real project cwd remains
 * folder-scoped exactly as before.
 */
function projectCwdForStore(store: Pick<LocalStore, "root">, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // A provider launched by a shortcut or a shell with no project can inherit
  // Windows' system directory. It is OS state, never an M9R project, and must
  // not pin an identity or an @mention to C:\\Windows\\System32.
  if (isWindowsSystemCwd(cwd)) return undefined;
  const root = normCwd(store.root);
  const candidate = normCwd(cwd);
  return root && (candidate === root || candidate.startsWith(`${root}/`)) ? undefined : cwd;
}

/** The task's goal is what the human wrote, minus the routing token, so the target reads a clean request. */
function goalFor(prompt: string, handle: string): string {
  // Claude Code wraps pasted text in <pasted_content ...> tags; they are not part of what the person asked.
  return prompt.replace(/<\/?pasted_content[^>]*>/gi, " ").replace(new RegExp(`@${handle}\\b`, "gi"), "").replace(/[ \t]{2,}/g, " ").trim();
}

function readMemoryIndex(cwd: string): string | null {
  try {
    const path = join(cwd, ".m9r", "memory", "index.md");
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
export function routeTypedMentions(input: HookInput, ctx: Pick<HookContext, "provider" | "store" | "pathExists" | "dispatch" | "strictTargetIdentity" | "captureMentionInput" | "rawPayload">): { acks: string[]; tasks: Array<{ id: string; to: string }> } {
  const self = handleForProvider(ctx.provider);
  const prompt = input.prompt ?? "";
  const cwd = input.cwd ?? process.cwd();
  const exists = ctx.pathExists ?? existsSync;
  const acks: string[] = [];
  const tasks: Array<{ id: string; to: string }> = [];
  const projectCwd = projectCwdForStore(ctx.store, input.cwd);
  ctx.store.registerEndpoint({ provider: ctx.provider, sessionId: input.session_id, cwd: projectCwd });
  // Handles inside pasted text (old test chatter, logs) were never addressed to anyone, so only what the person typed routes.
  // Text another agent sent into this session (a subagent report, a notification) is not the person typing, so it never routes.
  // A prompt M9R pushed in ("[M9R T3] Task from @claude ...") names its sender; routing that would bounce it back.
  const targets = isM9rPushedPrompt(prompt) || /<(?:agent-message|task-notification|cross-session-message)/.test(prompt) ? [] : findEndpointMentions(prompt.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/gi, " "), {
    aliases: ctx.store.knownAliases().filter((a) => a !== self),
    pathExists: (token) => exists(resolve(join(cwd, token))),
  });
  if (targets.length) {
    try { ctx.captureMentionInput?.({ ...input, cwd: projectCwd }, targets, ctx.rawPayload); }
    catch { /* diagnostics cannot block delivery */ }
  }
  for (const to of targets) {
    const goal = goalFor(prompt, to);
    if (!goal) continue;
    const enforceIdentity = ctx.strictTargetIdentity === true;
    const knownTargetSessions = enforceIdentity ? ctx.store.sessionsFor(to, projectCwd) : [];
    const identityTargetSessions = enforceIdentity ? ctx.store.sessionsWithIdentity(to, projectCwd) : [];
    const targetSession = enforceIdentity && knownTargetSessions.length > 0 && identityTargetSessions.length === 1 ? identityTargetSessions[0].sessionId : undefined;
    const { task, created } = ctx.store.addTask({ from: self, to, goal: goal.slice(0, MAX_GOAL_CHARS * 2), origin: "human_typed", ...(projectCwd ? { cwd: projectCwd } : {}), fromSession: input.session_id, ...(targetSession ? { targetSession } : {}), idempotencyKey: sha(`${input.session_id ?? ""}|${to}|${prompt}`) });
    if (enforceIdentity && created && identityTargetSessions.length === 0) {
      const reason = `@${to} has no session with an active M9R identity. Start or reconnect the target session so it receives an M9R SessionStart card, then retry.`;
      ctx.store.setDelivery(task.id, { state: "failed", error: reason });
      acks.push(`M9R could not deliver task ${task.id} to @${to}: ${reason}`);
      tasks.push({ id: task.id, to });
      continue;
    }
    if (enforceIdentity && created && identityTargetSessions.length > 1 && !targetSession) {
      const reason = `@${to} has multiple authenticated sessions in this folder; M9R will not guess. Aim the task at one session and retry.`;
      ctx.store.setDelivery(task.id, { state: "failed", error: reason });
      acks.push(`M9R could not deliver task ${task.id} to @${to}: ${reason}`);
      tasks.push({ id: task.id, to });
      continue;
    }
    // Codex is pushed by its queue adapter. OpenCode's installed plugin polls the live session and calls its session API;
    // other providers receive inbox context at their next supported hook. A target without an identity waits until it connects.
    const pushed = created && to === "codex" && canQueue(task) && ctx.dispatch !== undefined;
    if (!pushed && created) {
      const live = ctx.store.sessionsWithIdentity(to, projectCwd);
      acks.push(live.length > 0
        ? to === "opencode" ? renderOpenCodePendingAck(task.id) : renderInboxAck(task.id, to)
        : renderHeldAck(task.id, to));
    } else {
      acks.push(renderSentAck(task.id, to));
    }
    tasks.push({ id: task.id, to });
    if (pushed) ctx.dispatch?.(task.id);
  }
  return { acks, tasks };
}

export function handleHookEvent(input: HookInput, ctx: HookContext): AdditionalContext | null {
  try {
    const event = input.hook_event_name ?? "";
    const self = handleForProvider(ctx.provider);
    const now = (ctx.now ?? (() => new Date()))();
    const activeWindow = ctx.activeWindowMs ?? 10 * 60_000;
    const projectCwd = projectCwdForStore(ctx.store, input.cwd);

    if (event === "SessionStart") {
      ctx.store.registerEndpoint({ provider: ctx.provider, sessionId: input.session_id, cwd: projectCwd });
      const others = ctx.store.listEndpoints().filter((e) => e.handle !== self && now.getTime() - Date.parse(e.lastSeenAt) < activeWindow).map((e) => ({ handle: e.handle }));
      const pending = input.session_id
        ? renderInboxInjection(ctx.store.tasksForSession(self, input.session_id), ctx.store.cursorFor(self, input.session_id, projectCwd), { now: now.getTime() }).includedIds.length
        : renderInboxInjection(ctx.store.tasksFor(self), ctx.store.cursorFor(self, input.session_id, projectCwd), { now: now.getTime() }).includedIds.length;
      // Only mention memory if the index file really exists here (the earlier card pointed at a file that did not).
      const memoryDir = ctx.memoryDir ?? (projectCwd && (ctx.pathExists ?? existsSync)(join(projectCwd, ".m9r", "memory", "index.md")) ? ".m9r/memory" : undefined);
      ctx.store.sweepExpired();
      const awaitingApproval = ctx.store.pendingApprovals().length;
      const identityToken = input.session_id ? ctx.store.issueIdentity(self, ctx.provider, input.session_id).token : undefined;
      return out(event, renderSessionCard({ handle: self, others, pendingCount: pending, awaitingApproval, memoryDir, identityToken }));
    }

    // The OpenCode plugin polls independently of user prompts, then inserts an approved task as a real prompt into
    // this exact live session. Never choose an arbitrary session when the task wasn't explicitly pinned.
    if (event === "OpenCodePoll") {
      if (self !== "opencode" || !input.session_id) return null;
      const sessionId = input.session_id;
      const identityToken = ctx.store.identityTokenFor(self, sessionId);
      if (!identityToken) return null;
      // Identity tokens outlive terminal sessions. Only recent sessions may compete
      // for an unpinned task; otherwise a closed terminal blocks delivery forever.
      ctx.store.registerEndpoint({ provider: ctx.provider, sessionId, cwd: projectCwd });
      const sessions = ctx.store.sessionsWithIdentity(self, projectCwd)
        .filter((session) => now.getTime() - Date.parse(session.lastSeenAt) < activeWindow);
      if (!sessions.some((session) => session.sessionId === sessionId)) return null;
      const cursor = ctx.store.cursorFor(self, sessionId, projectCwd);
      const maxAge = inboxMaxAgeMs();
      const task = ctx.store.tasksForSession(self, sessionId)
        .filter((candidate) => candidate.seq > cursor
          && canQueue(candidate)
          && !candidate.resultSummary
          && !candidate.delivery
          && (candidate.targetSession === sessionId || (!candidate.targetSession && sessions.length === 1))
          && (!candidate.cwd || (projectCwd && normCwd(candidate.cwd) === normCwd(projectCwd)))
          && Number.isFinite(Date.parse(candidate.createdAt))
          && now.getTime() - Date.parse(candidate.createdAt) >= 0
          && now.getTime() - Date.parse(candidate.createdAt) <= maxAge)
        .sort((left, right) => left.seq - right.seq)[0];
      if (!task) return null;
      const claimed = ctx.store.claimOpenCodeTask(task.id, {
        sessionId,
        identityToken,
        cwd: projectCwd,
        activeWindowMs: activeWindow,
        maxAgeMs: maxAge,
      });
      if (!claimed) return null;
      return out(event, JSON.stringify({ task_id: claimed.id, prompt: buildQueueMessage(claimed, identityToken) }));
    }

    // An OpenCode prompt is recorded as accepted only after the asynchronous provider API accepts it.
    // Acceptance does not claim that the agent has begun or completed the task.
    if (event === "OpenCodeDelivered") {
      if (self !== "opencode" || !input.session_id || !/^T\d{1,12}$/.test(input.task_id ?? "")) return null;
      const sessionId = input.session_id;
      const identityToken = ctx.store.identityTokenFor(self, sessionId);
      if (!identityToken) return null;
      ctx.store.registerEndpoint({ provider: ctx.provider, sessionId, cwd: projectCwd });
      const sessions = ctx.store.sessionsWithIdentity(self, projectCwd)
        .filter((session) => now.getTime() - Date.parse(session.lastSeenAt) < activeWindow);
      if (!sessions.some((session) => session.sessionId === sessionId)) return null;
      const task = ctx.store.getTask(input.task_id!);
      if (!task || task.to !== self) return null;
      if (task.delivery?.threadId !== sessionId
        || !(task.targetSession === sessionId || (!task.targetSession && sessions.length === 1))
        || (task.cwd && (!projectCwd || normCwd(task.cwd) !== normCwd(projectCwd)))) return null;
      const settled = ctx.store.settleOpenCodeTask(task.id, sessionId, identityToken, { state: "queued" });
      return settled ? out(event, JSON.stringify({ accepted: true, task_id: task.id })) : null;
    }

    // A prompt rejection is terminal; transport ambiguity is recorded separately. Neither state is replayed.
    if (event === "OpenCodeDeliveryFailed") {
      if (self !== "opencode" || !input.session_id || !/^T\d{1,12}$/.test(input.task_id ?? "")) return null;
      const sessionId = input.session_id;
      const identityToken = ctx.store.identityTokenFor(self, sessionId);
      if (!identityToken) return null;
      ctx.store.registerEndpoint({ provider: ctx.provider, sessionId, cwd: projectCwd });
      const sessions = ctx.store.sessionsWithIdentity(self, projectCwd)
        .filter((session) => now.getTime() - Date.parse(session.lastSeenAt) < activeWindow);
      if (!sessions.some((session) => session.sessionId === sessionId)) return null;
      const task = ctx.store.getTask(input.task_id!);
      if (!task || task.to !== self || task.delivery?.threadId !== sessionId) return null;
      const rejected = input.delivery_error === "session_rejected";
      const diagnostic = rejected ? "OpenCode rejected the task prompt." : "OpenCode could not confirm task delivery.";
      const settled = ctx.store.settleOpenCodeTask(task.id, sessionId, identityToken, {
        state: rejected ? "failed" : "uncertain",
        error: diagnostic,
      });
      return settled ? out(event, JSON.stringify({ accepted: true, task_id: task.id })) : null;
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

    // Claude only, NOT registered by default. Delivers new inbox items at the agent's next tool call with no polling, and
    // prints nothing when there is nothing new. Measured 2026-09-24 on Claude Code 2.1.278: the agent receives this text
    // but declines to act on it ("it was inside a tool result"), which is the right behavior for a web agent whose tool
    // results can carry a page's forged text. So this channel carries information, never a redirect; real interrupts go
    // through a live session's user-turn input (live-session-core.ts). Registering it would add a hook run to every tool call.
    if (event === "PostToolUse") {
      // This informational inbox hook is Claude-only. If an old or manually
      // copied hook registration fires for another provider, never inject the
      // same inbox task through a second delivery channel.
      if (self !== "claude") return null;
      const cursor = ctx.store.cursorFor(self, input.session_id, projectCwd);
      const injection = renderInboxInjection(input.session_id ? ctx.store.tasksForSession(self, input.session_id) : ctx.store.tasksFor(self), cursor, { now: now.getTime() });
      if (!injection.text) return null;
      ctx.store.setCursor(self, input.session_id, injection.newCursor, projectCwd);
      ctx.store.markDelivered(injection.includedIds, input.session_id);
      return out(event, injection.text.replace(/^M9R inbox \(/, "M9R inbox, arrived while you were working ("));
    }

    if (event === "UserPromptSubmit") {
      const prompt = input.prompt ?? "";
      const cwd = projectCwd ?? input.cwd ?? process.cwd();
      const parts: string[] = [];

      // SessionStart is a one-time provider event, but the local state can be
      // recovered or reinstalled while a provider session remains open. Heal
      // that split-brain state on the next trusted provider prompt so an
      // already-open Codex session does not stay permanently unable to receive
      // governed work. OpenCode has its own persistent SessionStart poller.
      const knownSession = input.session_id
        ? ctx.store.sessionsFor(self, projectCwd).some((session) => session.sessionId === input.session_id)
        : false;
      if (self === "codex" && input.session_id && knownSession && !ctx.store.identityTokenFor(self, input.session_id)) {
        const identity = ctx.store.issueIdentity(self, ctx.provider, input.session_id);
        parts.push(renderSessionCard({ handle: self, others: [], pendingCount: 0, awaitingApproval: 0, identityToken: identity.token }));
      }

      parts.push(...routeTypedMentions(input, ctx).acks);

      // A prompt M9R pushed in is a task by itself: nothing else (older inbox items, results) is mixed into it, or the agent
      // may answer the wrong one. Those items wait for the user's next real prompt.
      if (isM9rPushedPrompt(prompt)) return out(event, parts.join("\n"));

      // 2a. Answers to tasks we sent, once.
      try { ctx.collect?.(); } catch { /* a collect failure must never touch the prompt */ }
      const results = renderResultsInjection(ctx.store.tasksFrom(self), self);
      if (results.text) { parts.push(results.text); ctx.store.markResultShown(results.ids); }

      // 2b. Anything new in our own inbox, delta-only.
      const cursor = ctx.store.cursorFor(self, input.session_id, cwd);
      const injection = self === "opencode"
        ? { text: "", includedIds: [] as string[], newCursor: cursor, omitted: 0 }
        : renderInboxInjection(input.session_id ? ctx.store.tasksForSession(self, input.session_id) : ctx.store.tasksFor(self), cursor, { now: now.getTime() });
      if (injection.text) {
        const codexHasIdentity = self !== "codex" || Boolean(input.session_id && ctx.store.identityTokenFor(self, input.session_id));
        if (!codexHasIdentity) {
          parts.push("M9R is holding incoming work until this Codex session reconnects and receives an active M9R identity. No task details were included.");
        } else {
          parts.push(injection.text);
          ctx.store.setCursor(self, input.session_id, injection.newCursor, cwd);
          ctx.store.markDelivered(injection.includedIds, input.session_id);
        }
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
