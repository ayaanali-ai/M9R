/**
 * N2 I/O around the pure rules in codex-delivery-core: run `codex queue` for one task, and collect answers from the
 * rollout files of the sessions that were queued. Every dependency is injectable so the whole flow is tested without
 * a real Codex; `realDeps` is what the hook runner uses.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { buildQueueMessage, canQueue, findQueuedResult, interpretQueueExit, isThreadId, pickSession, nodeForCodex, normCwd, queueArgs, resolveCodexCommand, resultSummary, type CodexCommand } from "./codex-delivery-core";
import { windowsFileHolders, type Liveness } from "./codex-liveness";
import type { LocalStore } from "./local-store";

export interface DeliveryDeps {
  resolveCodex(): CodexCommand | null;
  runCodex(command: CodexCommand, args: string[]): Promise<{ code: number | null; stderr: string; spawnError?: string }>;
  /** Last bytes of the rollout file for a thread, or null when it cannot be found. */
  readRolloutTail(threadId: string): string | null;
  /** Which of these threads are open right now. Optional: without it (or with `unknown`) recency decides. */
  sessionLiveness?(threadIds: string[]): Promise<Record<string, Liveness>>;
}

export type DeliveryOutcome =
  | { state: "queued"; threadId: string }
  | { state: "failed"; reason: string }
  | { state: "skipped"; reason: string };

/** Pushes one task into the target Codex session. Only tasks a human typed or approved are ever pushed. */
export async function deliverToCodex(store: LocalStore, taskId: string, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  const task = store.getTask(taskId);
  if (!task) return { state: "skipped", reason: "no such task" };
  if (task.to !== "codex") return { state: "skipped", reason: "not addressed to codex" };
  if (!canQueue(task)) return { state: "skipped", reason: "waiting for approval" };
  if (task.delivery?.state === "queued" || task.delivery?.state === "done") return { state: "skipped", reason: "already pushed" };

  const attempts = (task.delivery?.attempts ?? 0) + 1;
  const fail = (reason: string): DeliveryOutcome => {
    store.setDelivery(taskId, { state: "failed", attempts, error: reason });
    return { state: "failed", reason };
  };
  const everySession = store.sessionsFor("codex");

  // Rule 1: an explicit link the person made (or M9R made from one clear match) always wins, even over folder or recency.
  const linked = task.fromSession && !task.targetSession ? store.linkedSession(task.from, task.fromSession, "codex") : undefined;
  if (linked && isThreadId(linked.sessionId) && everySession.some((s) => s.sessionId === linked.sessionId)) {
    const command = deps.resolveCodex();
    if (!command) return fail("The codex command was not found on this machine.");
    const outcome = interpretQueueExit(await deps.runCodex(command, queueArgs(linked.sessionId, buildQueueMessage(task))));
    if (!outcome.ok) return fail(outcome.error ?? "codex queue failed");
    store.setDelivery(taskId, { state: "queued", attempts, threadId: linked.sessionId, queuedAt: new Date().toISOString(), error: undefined });
    return { state: "queued", threadId: linked.sessionId };
  }

  // A task is aimed by folder: only sessions in the sender's own folder. A session anywhere else (even a parent folder) is never picked for
  // the sender: it could be another project, or an old thread, and a clean new session must never lose its task to one. Only an explicit
  // `--session`, or a sender with no known folder, may reach any session.
  let known = everySession;
  if (task.cwd && !task.targetSession) {
    const exact = everySession.filter((s) => normCwd(s.cwd) === normCwd(task.cwd));
    known = exact;
    if (known.length === 0 && everySession.length > 0) return fail(`No Codex session is open in ${task.cwd}. Open Codex there and send it one message (a fresh Codex has no session to push into yet), or aim a task: m9r-cli sessions, then m9r-cli send @codex --session <id> "..."`);
  }
  // Asking the machine costs about a second, so only when there is a choice to make and nobody pinned one.
  const liveness = !task.targetSession && known.length > 1 && deps.sessionLiveness ? await deps.sessionLiveness(known.map((s) => s.sessionId)).catch(() => undefined) : undefined;
  const choice = pickSession(known, { pinned: task.targetSession, senderCwd: task.cwd, now: new Date(), liveness });
  if (choice.kind === "none") return fail(task.targetSession ? `No Codex session matches "${task.targetSession}". See: m9r-cli sessions` : "No Codex session is known yet. Start a Codex session (with the M9R engine running) and send again.");
  if (choice.kind === "ambiguous") return fail(`${choice.sessions.length} Codex sessions are open here and M9R cannot tell which you mean, so it will show at the next prompt in whichever you use. To aim it: m9r-cli sessions, then m9r-cli send @codex --session <id> "..."`);
  // Rule 2: exactly one candidate was just resolved for a sender with a known session: remember it as an auto-link for next time.
  if (task.fromSession) store.setLink({ handle: task.from, sessionId: task.fromSession }, { handle: "codex", sessionId: choice.session.sessionId }, "auto");
  const endpoint = choice.session;
  if (!isThreadId(endpoint.sessionId)) return fail("The Codex session id looks wrong; open Codex again and retry.");
  const command = deps.resolveCodex();
  if (!command) return fail("The codex command was not found on this machine.");

  const outcome = interpretQueueExit(await deps.runCodex(command, queueArgs(endpoint.sessionId, buildQueueMessage(task))));
  if (!outcome.ok) return fail(outcome.error ?? "codex queue failed");
  store.setDelivery(taskId, { state: "queued", attempts, threadId: endpoint.sessionId, queuedAt: new Date().toISOString(), error: undefined });
  return { state: "queued", threadId: endpoint.sessionId };
}

/** Sends the answer to a task back into the Codex session that asked (queued like any pushed message). */
export async function pushAnswerToCodex(store: LocalStore, taskId: string, deps: Pick<DeliveryDeps, "resolveCodex" | "runCodex">): Promise<DeliveryOutcome> {
  const task = store.getTask(taskId);
  if (!task || !task.resultSummary) return { state: "skipped", reason: "no answer yet" };
  if (task.from !== "codex" || !isThreadId(task.fromSession)) return { state: "skipped", reason: "the asker is not a Codex session we can push into" };
  if (task.answerPushedAt) return { state: "skipped", reason: "already sent back" };
  const command = deps.resolveCodex();
  if (!command) return { state: "failed", reason: "The codex command was not found on this machine." };
  const goal = task.goal.length > 90 ? `${task.goal.slice(0, 89)}…` : task.goal;
  const message = `[M9R ${task.id}] Answer from @${task.to} to your task "${goal}":\n${task.resultSummary}\n\nThis is the answer you asked for. Acknowledge it in one short line.`;
  const outcome = interpretQueueExit(await deps.runCodex(command, queueArgs(task.fromSession, message)));
  if (!outcome.ok) return { state: "failed", reason: outcome.error ?? "codex queue failed" };
  store.setAnswerPushed(task.id);
  return { state: "queued", threadId: task.fromSession };
}

/** Reads back answers for every pushed task that has none yet. Cheap when nothing is waiting (no file is opened). */
export function collectCodexResults(store: LocalStore, deps: Pick<DeliveryDeps, "readRolloutTail">): number {
  let collected = 0;
  for (const task of store.awaitingResults()) {
    const threadId = task.delivery?.threadId;
    if (!threadId) continue;
    const tail = deps.readRolloutTail(threadId);
    if (!tail) continue;
    const result = findQueuedResult(tail, task.id);
    if (result.done) {
      store.setResult(task.id, resultSummary(task.id, result.message));
      collected += 1;
    }
  }
  return collected;
}

// ---------------------------------------------------------------------------------------------------------------
// Real implementations

const TAIL_BYTES = 512 * 1024;
const LIVENESS_FRESH_MS = 20_000;
/** Who holds which session file open, remembered briefly within this process (the resident engine). */
const livenessMemo = new Map<string, { v: Liveness; at: number }>();

export function codexHome(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * Codex rotates a thread onto a new rollout file as it grows (compaction/resume), keeping the same thread id but
 * appending a second, fresh id to the filename: `rollout-<ts>-<threadId>.jsonl` becomes
 * `rollout-<ts>-<threadId>_<newId>.jsonl`, then rotates again onto yet another `_<newId>.jsonl` from there. An exact
 * `-${threadId}.jsonl` suffix match only ever finds the very first file, which Codex closed at the first rotation --
 * live/free checks against it are checking a file nobody has held open in days. Match the optional `_<uuid>` tail too.
 */
export function findRolloutFile(home: string, threadId: string): string | null {
  const root = join(home, "sessions");
  const pattern = new RegExp(`-${threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_[0-9a-f-]+)?\\.jsonl$`, "i");
  const list = (dir: string): string[] => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
  for (const y of list(root)) for (const m of list(join(root, y))) for (const d of list(join(root, y, m))) {
    for (const f of list(join(root, y, m, d))) if (pattern.test(f)) return join(root, y, m, d, f);
  }
  return null;
}

export function readTail(path: string, bytes: number): string | null {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** The tail of a session's rollout file, for callers outside the delivery flow (the overlay feed). */
export function readRolloutTailFor(threadId: string, env: Record<string, string | undefined> = process.env, bytes = 64 * 1024): string | null {
  const file = findRolloutFile(codexHome(env), threadId);
  return file ? readTail(file, bytes) : null;
}

export function realDeps(env: Record<string, string | undefined> = process.env): DeliveryDeps {
  return {
    resolveCodex: () => resolveCodexCommand({
      platform: process.platform,
      pathDirs: (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean),
      nodePath: nodeForCodex(process.execPath, (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), existsSync),
      exists: existsSync,
    }),
    runCodex: (command, args) => new Promise((resolve) => {
      let stderr = "";
      let settled = false;
      const done = (r: { code: number | null; stderr: string; spawnError?: string }) => { if (!settled) { settled = true; resolve(r); } };
      try {
        const child = spawn(command.command, [...command.args, ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        const timer = setTimeout(() => { child.kill(); done({ code: null, stderr, spawnError: "codex queue timed out after 20s" }); }, 20_000);
        child.stderr?.on("data", (c) => { stderr += String(c).slice(0, 2000); });
        child.on("error", (e) => { clearTimeout(timer); done({ code: null, stderr, spawnError: e.message }); });
        child.on("close", (code) => { clearTimeout(timer); done({ code, stderr }); });
      } catch (e) {
        done({ code: null, stderr, spawnError: e instanceof Error ? e.message : String(e) });
      }
    }),
    readRolloutTail: (threadId) => {
      const file = findRolloutFile(codexHome(env), threadId);
      return file ? readTail(file, TAIL_BYTES) : null;
    },
    sessionLiveness: async (threadIds) => {
      // The feed already asks the machine every few seconds; a push right after should not pay for the same 2 s question again.
      const now = Date.now();
      const out: Record<string, Liveness> = {};
      const missing: string[] = [];
      for (const id of threadIds) {
        const hit = livenessMemo.get(id);
        if (hit && now - hit.at < LIVENESS_FRESH_MS) out[id] = hit.v; else missing.push(id);
      }
      if (missing.length > 0) {
        const byFile = new Map<string, string>();
        for (const id of missing) { const f = findRolloutFile(codexHome(env), id); if (f) byFile.set(f, id); }
        const verdicts = await windowsFileHolders([...byFile.keys()]);
        for (const id of missing) out[id] = "unknown";
        for (const [file, id] of byFile) out[id] = verdicts[file] ?? "unknown";
        for (const id of missing) if (out[id] !== "unknown") livenessMemo.set(id, { v: out[id], at: Date.now() });
      }
      return out;
    },
  };
}

/** Starts the delivery in a separate process so a hook never waits for Codex. Fire and forget. */
export function spawnDeliveryRunner(hookEntry: string, taskId: string, env: Record<string, string | undefined> = process.env, mode: "queue" | "answer" = "queue"): void {
  try {
    // The engine is its own program: it takes the hook as a subcommand. Otherwise the hook entry is a script for node.
    const engine = /m9r-engine(\.exe)?$/i.test(hookEntry);
    const child = engine
      ? spawn(hookEntry, ["m9r-hook", mode, "codex", taskId], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } })
      : spawn(process.execPath, [hookEntry, mode, "codex", taskId], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } });
    child.unref();
  } catch { /* the task stays in the inbox and shows at Codex's next prompt */ }
}
