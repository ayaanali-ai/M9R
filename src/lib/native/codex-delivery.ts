/**
 * N2 I/O around the pure rules in codex-delivery-core: run `codex queue` for one task, and collect answers from the
 * rollout files of the sessions that were queued. Every dependency is injectable so the whole flow is tested without
 * a real Codex; `realDeps` is what the hook runner uses.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { buildQueueMessage, canQueue, findQueuedResult, interpretQueueExit, isThreadId, queueArgs, resolveCodexCommand, resultSummary, type CodexCommand } from "./codex-delivery-core";
import type { LocalStore } from "./local-store";

export interface DeliveryDeps {
  resolveCodex(): CodexCommand | null;
  runCodex(command: CodexCommand, args: string[]): Promise<{ code: number | null; stderr: string; spawnError?: string }>;
  /** Last bytes of the rollout file for a thread, or null when it cannot be found. */
  readRolloutTail(threadId: string): string | null;
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
  const endpoint = store.listEndpoints().find((e) => e.handle === "codex");
  if (!isThreadId(endpoint?.sessionId)) return fail("No Codex session is known yet. Open Codex once with the M9R hooks trusted, then send again.");
  const command = deps.resolveCodex();
  if (!command) return fail("The codex command was not found on this machine.");

  const outcome = interpretQueueExit(await deps.runCodex(command, queueArgs(endpoint.sessionId, buildQueueMessage(task))));
  if (!outcome.ok) return fail(outcome.error ?? "codex queue failed");
  store.setDelivery(taskId, { state: "queued", attempts, threadId: endpoint.sessionId, queuedAt: new Date().toISOString(), error: undefined });
  return { state: "queued", threadId: endpoint.sessionId };
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

function codexHome(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function findRolloutFile(home: string, threadId: string): string | null {
  const root = join(home, "sessions");
  const suffix = `-${threadId}.jsonl`;
  const list = (dir: string): string[] => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
  for (const y of list(root)) for (const m of list(join(root, y))) for (const d of list(join(root, y, m))) {
    for (const f of list(join(root, y, m, d))) if (f.endsWith(suffix)) return join(root, y, m, d, f);
  }
  return null;
}

function readTail(path: string, bytes: number): string | null {
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

export function realDeps(env: Record<string, string | undefined> = process.env): DeliveryDeps {
  return {
    resolveCodex: () => resolveCodexCommand({
      platform: process.platform,
      pathDirs: (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean),
      nodePath: process.execPath,
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
  };
}

/** Starts the delivery in a separate process so a hook never waits for Codex. Fire and forget. */
export function spawnDeliveryRunner(hookEntry: string, taskId: string, env: Record<string, string | undefined> = process.env): void {
  try {
    const child = spawn(process.execPath, [hookEntry, "queue", "codex", taskId], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } });
    child.unref();
  } catch { /* the task stays in the inbox and shows at Codex's next prompt */ }
}
