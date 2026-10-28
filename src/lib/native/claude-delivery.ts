/**
 * Automatic delivery into an already-open Claude Code conversation.
 *
 * Claude's ordinary interactive process does not expose a supported "inject a
 * new user turn" API. The supported provider boundary is Claude Code's
 * stream-json process with --resume: it continues the exact conversation while
 * keeping the input on a real user-message channel. This adapter is therefore
 * deliberately conservative. It never invents a session, never selects among
 * multiple sessions, and never falls back to a broad inbox read.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, type Task } from "./inbox-core";
import { buildQueueMessage, canQueue, normCwd } from "./codex-delivery-core";
import { claudeSessionsDir, readClaudeSessions, type ClaudeSession } from "./claude-registry";
import type { LocalStore } from "./local-store";
import { startLiveSession, type LiveEvent, type LiveProcess, type LiveSession } from "./live-session-core";

export interface ClaudeDeliveryOptions {
  root: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Existing M9R Claude MCP config candidates, in preferred order. */
  mcpConfigPaths: readonly string[];
  cwd?: string;
  now?: () => Date;
  /** Maximum time to wait for Claude to identify the requested resumed conversation. */
  sessionInitTimeoutMs?: number;
  /** Injected in tests; production uses the signed-in `claude` executable. */
  spawnClaude?: (command: string, args: string[], cwd: string) => LiveProcess;
}

export type ClaudeDeliveryOutcome =
  | { state: "accepted"; threadId: string }
  | { state: "unavailable"; reason: string }
  | { state: "ineligible" | "owned"; reason: string }
  | { state: "failed" | "uncertain"; reason: string };

interface ActiveDelivery {
  live?: LiveSession;
  sent: boolean;
  sawResult: boolean;
  wrongSession: boolean;
  exited: boolean;
}

const messageFor = (task: Pick<Task, "id" | "from" | "goal">): string => buildQueueMessage(task);

function defaultSpawnClaude(options: ClaudeDeliveryOptions, command: string, args: string[], cwd: string): LiveProcess {
  const child = nodeSpawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...options.env,
      M9R_HOME: options.root,
      M9R_PROVIDER: "claude-code",
    } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin?.on("error", () => undefined);
  return child as unknown as LiveProcess;
}

function sameFolder(left: string | undefined, right: string | undefined): boolean {
  const a = normCwd(left);
  const b = normCwd(right);
  return Boolean(a && b && a === b);
}

function liveIdleCandidates(task: Task, sessions: readonly ClaudeSession[]): ClaudeSession[] {
  const target = task.targetSession;
  const scoped = sessions.filter((session) => session.status === "idle"
    && (!target || session.sessionId === target)
    && (!task.cwd ? true : sameFolder(session.cwd, task.cwd)));
  return scoped;
}

function chooseSession(store: LocalStore, task: Task, sessions: readonly ClaudeSession[], active: ReadonlyMap<string, ActiveDelivery>): ClaudeSession | undefined {
  // Do not hide an unauthenticated competitor before deciding whether the
  // target is ambiguous. That would let one known session win merely because
  // another live session has not republished its claim yet.
  const candidates = liveIdleCandidates(task, sessions).filter((session) => !active.has(session.sessionId));
  if (candidates.length !== 1) return undefined;
  const session = candidates[0]!;
  if (!store.identityTokenFor("claude", session.sessionId)) {
    // Claude's registry is provider-owned discovery. Reuse the existing
    // recovery fence to republish the private identity after an update,
    // restart, or missed hook, but only for this exact live PID/session/folder.
    // A revoked identity remains revoked because recoverProviderConnection
    // checks that boundary before issuing anything.
    store.registerEndpoint({
      provider: "claude-code",
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(session.updatedAt !== undefined && Number.isFinite(session.updatedAt)
        ? { seenAt: new Date(session.updatedAt).toISOString() }
        : {}),
    });
    const recovered = store.reconcileLiveProviderConnection({
      provider: "claude-code",
      sessionId: session.sessionId,
      cwd: session.cwd,
      processId: session.pid,
    });
    if (!recovered) {
      // Identity publication and connection binding are one recovery decision
      // from the adapter's perspective. Do not leave a half-recovered token
      // that could make a later transport look authenticated without a claim.
      store.revokeIdentity(session.sessionId);
      return undefined;
    }
  }
  return store.identityTokenFor("claude", session.sessionId) ? session : undefined;
}

function transportError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 240) || "Claude delivery failed.";
}

/**
 * Creates the native Claude adapter used by the resident feed pump.
 *
 * The returned function is intentionally a no-op when it cannot prove an
 * exact target session. The task remains deferred and can still be delivered
 * by the normal SessionStart/UserPromptSubmit hook path; a silent no-op is
 * safer than guessing a session or spawning an unrelated one.
 */
export function createClaudeDeliveryAdapter(options: ClaudeDeliveryOptions, store: LocalStore): (taskId: string) => Promise<ClaudeDeliveryOutcome> {
  const active = new Map<string, ActiveDelivery>();
  const configPath = () => options.mcpConfigPaths.find((path) => typeof path === "string" && path.length > 0 && existsSync(path));

  return async (taskId) => {
    const task = store.getTask(taskId);
    if (!task || task.to !== "claude" || task.resultSummary || !canQueue(task)) return { state: "ineligible", reason: "not an eligible Claude task" };
    const mcpConfigPath = configPath();
    if (!mcpConfigPath) return { state: "unavailable", reason: "no installed Claude M9R MCP configuration was found" };

    const sessionsEnv = {
      ...options.env,
      CLAUDE_CONFIG_DIR: options.env.CLAUDE_CONFIG_DIR?.trim() || join(options.homeDir, ".claude"),
    };
    const sessions = readClaudeSessions(claudeSessionsDir(sessionsEnv));
    const session = chooseSession(store, task, sessions, active);
    if (!session) return { state: "unavailable", reason: "no one unambiguous idle M9R Claude session is available" };
    const token = store.identityTokenFor("claude", session.sessionId);
    if (!token || active.has(session.sessionId)) return { state: "unavailable", reason: "the selected Claude session has no usable M9R identity" };

    // This is the durable ownership fence. It is checked before a process is
    // started, so a second feed or a manual inbox read cannot claim the same
    // task after this adapter has selected its exact session.
    if (!store.bindTaskToSession(taskId, token)) return { state: "owned", reason: "another delivery path already owns this task" };
    const claimedAt = (options.now ?? (() => new Date()))().toISOString();
    store.setDelivery(taskId, {
      state: "sending",
      attempts: (task.delivery?.attempts ?? 0) + 1,
      threadId: session.sessionId,
      claimedAt,
      correlation: "internal-context",
      transport: "claude-resume",
    });

    const record: ActiveDelivery = { sent: false, sawResult: false, wrongSession: false, exited: false };
    let settleInit!: (result: { ok: true } | { ok: false; reason: string }) => void;
    let initSettled = false;
    const init = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      settleInit = (result) => {
        if (initSettled) return;
        initSettled = true;
        resolve(result);
      };
    });
    let stderrTail = "";
    const handleExit = (code: number | null): void => {
      record.exited = true;
      active.delete(session.sessionId);
      settleInit({ ok: false, reason: "Claude exited before confirming the requested session." });
      const current = store.getTask(taskId);
      if (current?.resultSummary || record.sawResult) return;
      store.setDelivery(taskId, {
        state: record.sent ? "uncertain" : "failed",
        threadId: session.sessionId,
        error: record.wrongSession
          ? "Claude resume returned a different session; M9R did not replay the task."
          : record.sent
            ? `Claude resume exited before M9R confirmed the provider turn. Exit=${code ?? "unknown"}. ${stderrTail}`
            : `Claude could not accept the resumed provider turn. Exit=${code ?? "unknown"}. ${stderrTail}`,
      });
    };
    const onEvent = (event: LiveEvent): void => {
      if (event.kind === "init" && event.sessionId !== session.sessionId) {
        // --resume must not silently create a different conversation. Stop the
        // transport and fence the task against automatic replay.
        record.wrongSession = true;
        settleInit({ ok: false, reason: "Claude resumed a different session; no task text was sent." });
        record.live?.stop();
        return;
      }
      if (event.kind === "init") settleInit({ ok: true });
      if (event.kind === "result") {
        record.sawResult = true;
        if (event.isError && !store.getTask(taskId)?.resultSummary) {
          store.setDelivery(taskId, { state: "failed", threadId: session.sessionId, error: event.text || "Claude reported a provider execution failure." });
        }
        // The result event is emitted after Claude has completed its MCP calls;
        // close this resumed transport without killing the user's interactive
        // Claude process represented by the registry session.
        setTimeout(() => record.live?.stop(), 0).unref?.();
      }
    };

    try {
      const live = startLiveSession({
        config: {
          cwd: session.cwd ?? options.cwd ?? process.cwd(),
          profile: "web-only",
          mcpConfigPath,
          resumeSessionId: session.sessionId,
        },
        env: { ...options.env, M9R_HOME: options.root, M9R_PROVIDER: "claude-code" },
        spawn: (command, args, cwd) => {
          const child = options.spawnClaude ? options.spawnClaude(command, args, cwd) : defaultSpawnClaude(options, command, args, cwd);
          child.stderr?.on("data", (chunk) => { stderrTail = redactSecrets((stderrTail + String(chunk)).slice(-2000)).replace(/\s+/g, " ").slice(-240); });
          return child;
        },
        onEvent,
        onExit: handleExit,
      });
      record.live = live;
      active.set(session.sessionId, record);
      const initTimer = setTimeout(
        () => settleInit({ ok: false, reason: "Claude did not confirm the requested session before the startup deadline." }),
        Math.max(1, options.sessionInitTimeoutMs ?? 15_000),
      );
      initTimer.unref?.();
      const initialized = await init;
      clearTimeout(initTimer);
      if (!initialized.ok || record.wrongSession || record.exited || live.state().status === "exited") {
        live.stop();
        active.delete(session.sessionId);
        const reason = initialized.ok ? "Claude exited before accepting the task." : initialized.reason;
        store.setDelivery(taskId, {
          state: "failed",
          threadId: session.sessionId,
          error: reason,
        });
        return { state: "failed", reason };
      }
      live.send(messageFor(task));
      record.sent = true;
      const queued = store.setDelivery(taskId, {
        state: "queued",
        threadId: session.sessionId,
        queuedAt: (options.now ?? (() => new Date()))().toISOString(),
        correlation: "internal-context",
      });
      if (!queued || (queued.delivery?.state !== "queued" && queued.delivery?.state !== "done" && !queued.resultSummary)) {
        const reason = "Claude accepted the prompt, but M9R could not confirm the durable delivery receipt; it will not replay the task.";
        store.setDelivery(taskId, { state: "uncertain", threadId: session.sessionId, error: reason });
        return { state: "uncertain", reason };
      }
      return { state: "accepted", threadId: session.sessionId };
    } catch (error) {
      active.delete(session.sessionId);
      record.live?.stop();
      store.setDelivery(taskId, {
        state: record.sent ? "uncertain" : "failed",
        threadId: session.sessionId,
        error: transportError(error),
      });
      return { state: record.sent ? "uncertain" : "failed", reason: transportError(error) };
    }
  };
}
