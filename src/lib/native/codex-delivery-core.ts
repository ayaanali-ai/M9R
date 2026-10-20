/**
 * N2: pushing a task into a running Codex session with `codex queue --thread <id> --message <text>` and reading the
 * answer back from that session's rollout file. Pure functions only; the hook and the runner do the I/O.
 *
 * Why the gate matters: a queued message is a real user prompt to Codex, so it bypasses the model's own distrust of
 * injected text. `canQueue` is therefore the ONLY thing that decides whether a task may be pushed.
 */
import { posix, win32 } from "node:path";
import type { Task } from "./inbox-core";
import { isM9rWorkspaceEnvelope } from "./m9r-prompt-markers";
import { taskCorrelationMarker, visibleTaskText } from "./task-execution-context";

/** A task may be pushed only when a human typed it or approved it. Everything else stays in the inbox. */
export function canQueue(task: Pick<Task, "origin" | "approval">): boolean {
  if (task.approval === "denied" || task.approval === "expired" || task.approval === "pending") return false;
  return task.approval === "approved" || task.approval === "not_needed";
}

/** Internal context marker used by legacy rollout reconciliation, never visible task text. */
export const queueMarker = taskCorrelationMarker;

/**
 * The prompt the broker builds for a web-room agent (webAgentPrompt) lists its teammates as @handles and carries its session token.
 * It is machine-written, never something the owner typed, so a hook or watcher that sees it must not turn those mentions into tasks.
 */
export const isBrokerAgentPrompt = (prompt: string) => /You are @[a-z0-9-]+, an agent working for the owner in their own web browser through M9R/.test(prompt)
  // The shorter prompt a resumed web worker gets: it only refreshes the session token and restates the room rules.
  || /^\s*Your current M9R session token is \S+\. Use it only on M9R tools/.test(prompt)
  || prompt.includes("M9R tools may only be reachable as deferred tools through your exec/code gateway");

/** Stable, human-readable envelope prefix for an answer queued back into Codex. It carries no task/session identity. */
export const M9R_PUSHED_RESULT_PREFIX = "A teammate completed the work you asked for:";

/** True for a prompt M9R itself pushed into a session. Its @mentions are the sender's name, not a new request to route. */
export const isM9rPushedPrompt = (prompt: string) => /^\s*\[M9R T\d+\]/.test(prompt)
  || prompt.trimStart().startsWith(M9R_PUSHED_RESULT_PREFIX)
  || isBrokerAgentPrompt(prompt)
  || isM9rWorkspaceEnvelope(prompt);

export function buildQueueMessage(task: Pick<Task, "id" | "from" | "goal">, sessionToken?: string): string {
  // Correlation belongs in the trusted adapter context. The body is only the task text; never forward the
  // sender's surrounding prompt, chat transcript, routing explanation, or unrelated context into the target session.
  void sessionToken;
  return visibleTaskText(task);
}

/**
 * `codex.js` needs a real Node. Normally that is the running process; inside the self-contained engine it is not (the engine
 * cannot run other scripts), so use the `node` on PATH, which a Codex installed through npm always has.
 */
export function nodeForCodex(execPath: string, pathDirs: string[], exists: (p: string) => boolean): string {
  if (!/^m9r-(engine|web-broker)(\.exe)?$/i.test(win32.basename(execPath))) return execPath;
  for (const dir of pathDirs) for (const name of ["node.exe", "node"]) { const p = win32.join(dir, name); if (exists(p)) return p; }
  return "node";
}

export interface CodexCommand {
  command: string;
  args: string[];
}

/**
 * How to run codex without a shell. On Windows the `codex` on PATH is a `.cmd` shim that cannot be spawned directly
 * (and quoting a message through cmd.exe is what broke before), so we run the JS entry it points at with node.
 */
export function resolveCodexCommand(input: {
  platform: NodeJS.Platform;
  pathDirs: string[];
  nodePath: string;
  exists: (p: string) => boolean;
}): CodexCommand | null {
  const win = input.platform === "win32";
  const join = win ? win32.join : posix.join;
  for (const dir of input.pathDirs) {
    if (win) {
      if (!input.exists(join(dir, "codex.cmd"))) continue;
      const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (input.exists(js)) return { command: input.nodePath, args: [js] };
    } else if (input.exists(join(dir, "codex"))) {
      return { command: join(dir, "codex"), args: [] };
    }
  }
  return null;
}

export interface SessionLike { sessionId: string; cwd?: string; lastSeenAt: string }

export type SessionChoice =
  | { kind: "one"; session: SessionLike }
  | { kind: "ambiguous"; sessions: SessionLike[] }
  | { kind: "none" };

const SESSION_WINDOW_MS = 24 * 60 * 60_000;
const CLEAR_WINNER_RECENT_MS = 12 * 60 * 60_000;
const CLEAR_WINNER_GAP_MS = 5 * 60_000;
export const normCwd = (p: string | undefined) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** A launcher may inherit Windows' system directory when no project was supplied.
 * System32/SysWOW64 are OS state, never a user's project, and must not become a
 * routing constraint for an agent session. */
export function isWindowsSystemCwd(cwd: string | undefined): boolean {
  const value = normCwd(cwd);
  return /^(?:[a-z]:)?\/windows\/(?:system32|syswow64)(?:\/|$)/i.test(value);
}

/** True when one folder is the other or contains it. */
export const foldersRelated = (a: string | undefined, b: string | undefined): boolean => {
  const x = normCwd(a), y = normCwd(b);
  return !!x && !!y && (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`));
};

/**
 * Which session to push into. Codex has no session-end hook and its hook payload has no process id, but a live session
 * holds its rollout file open (see codex-liveness). Open sessions are preferred; between several this never guesses: a pinned id wins; one recent session is used;
 * with several, the one in the sender's own working directory is used if it is the only one there; otherwise the caller
 * gets `ambiguous` and the task falls back to the inbox (delivered at the next prompt of whichever session the user uses).
 */
export function pickSession(sessions: readonly SessionLike[], input: { pinned?: string; senderCwd?: string; now: Date; windowMs?: number; liveness?: Readonly<Record<string, "live" | "free" | "unknown">> }): SessionChoice {
  if (input.pinned) {
    const hits = sessions.filter((s) => s.sessionId.startsWith(input.pinned as string));
    return hits.length === 1 ? { kind: "one", session: hits[0] } : hits.length === 0 ? { kind: "none" } : { kind: "ambiguous", sessions: [...hits] };
  }
  const cutoff = input.now.getTime() - (input.windowMs ?? SESSION_WINDOW_MS);
  let fresh = sessions.filter((s) => Date.parse(s.lastSeenAt) >= cutoff);
  // If the machine can say which sessions are open, only those are candidates. When it says none are (or says nothing),
  // recency decides as before, so a Desktop thread that does not hold its file is never wrongly ruled out.
  const open = fresh.filter((s) => input.liveness?.[s.sessionId] === "live");
  if (open.length > 0) fresh = open;
  if (fresh.length === 0) return { kind: "none" };
  if (fresh.length === 1) return { kind: "one", session: fresh[0] };
  const here = input.senderCwd ? fresh.filter((s) => normCwd(s.cwd) === normCwd(input.senderCwd)) : [];
  if (here.length === 1) return { kind: "one", session: here[0] };
  // Several threads in the same place: the one in use right now is the one meant, but only when it is clearly the one in use (used in the
  // last 12 hours while every other thread in that folder has been quiet for at least 5 minutes longer). Otherwise never guess.
  const pool = (here.length > 1 ? here : fresh).slice().sort((x, y) => Date.parse(y.lastSeenAt) - Date.parse(x.lastSeenAt));
  const newest = Date.parse(pool[0].lastSeenAt);
  const recent = input.now.getTime() - newest <= CLEAR_WINNER_RECENT_MS;
  const rivalsQuiet = pool.slice(1).every((x) => newest - Date.parse(x.lastSeenAt) > CLEAR_WINNER_GAP_MS);
  if (recent && rivalsQuiet) return { kind: "one", session: pool[0] };
  return { kind: "ambiguous", sessions: [...pool] };
}

export const queueArgs = (threadId: string, message: string) => ["queue", "--thread", threadId, "--message", message];

/** Thread ids are UUIDs; refuse anything else so an odd session id can never become an odd argument. */
export const isThreadId = (id: string | undefined): id is string => !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export interface QueueOutcome {
  ok: boolean;
  error?: string;
}

/** Turns a finished `codex queue` process into a delivery state the ledger can show. */
export function interpretQueueExit(exit: { code: number | null; stderr: string; spawnError?: string }): QueueOutcome {
  if (exit.spawnError) return { ok: false, error: `could not start codex: ${exit.spawnError}` };
  if (exit.code === 0) return { ok: true };
  const detail = exit.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 200);
  return { ok: false, error: detail || `codex queue exited with ${exit.code}` };
}

export interface RolloutResult {
  /** The queued prompt was found in the file. */
  seen: boolean;
  /** The turn that answered it finished; `message` is Codex's final message. */
  done: boolean;
  message?: string;
}

/**
 * Reads the tail of a rollout file (JSON lines) for the answer to a queued task. Codex can fold several queued prompts
 * into one turn (verified on 0.153.4: a resumed thread answered the queued task and the next prompt inside one turn,
 * so `task_complete` carries only the LAST answer). So the answer is the assistant's own message that follows the
 * marked prompt, up to the next user prompt or the end of the turn; `last_agent_message` is only the fallback.
 * Only the tail is passed in, because rollout files can be tens of megabytes.
 */
export function findQueuedResult(tailText: string, taskId: string): RolloutResult {
  const marker = queueMarker(taskId);
  let seen = false;
  let answer: string | undefined;
  for (const line of tailText.split(/\r?\n/)) {
    let row: { type?: string; payload?: { role?: string; phase?: string; type?: string; message?: string; content?: Array<{ text?: string }>; last_agent_message?: unknown } };
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const payload = row.payload;
    const userTexts = payload?.role === "user" && Array.isArray(payload.content) ? payload.content.flatMap(part => part && typeof part.text === "string" ? [part.text] : [])
      : row.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string" ? [payload.message] : [];
    const markedUserPrompt = userTexts.some(text => text.trimStart().startsWith(marker));
    if (!seen) {
      if (markedUserPrompt) seen = true;
      continue;
    }
    if (userTexts.length && !markedUserPrompt) {
      if (answer !== undefined) return { seen: true, done: true, message: answer };
      return { seen: true, done: false };
    }
    if (payload?.role === "assistant" && (!payload.phase || payload.phase === "final" || payload.phase === "final_answer")) {
      const text = assistantText(line);
      if (text) answer = text;
      continue;
    }
    if (line.includes('"task_complete"')) {
      try {
        const payload = (JSON.parse(line) as { payload?: { type?: string; last_agent_message?: unknown } }).payload;
        if (payload?.type === "task_complete") {
          return { seen: true, done: true, message: answer ?? (typeof payload.last_agent_message === "string" ? payload.last_agent_message : "") };
        }
      } catch { /* a cut-off line: skip */ }
    }
  }
  return { seen, done: false };
}

function assistantText(line: string): string | undefined {
  try {
    const payload = (JSON.parse(line) as { payload?: { role?: string; content?: Array<{ type?: string; text?: string }> } }).payload;
    if (payload?.role !== "assistant") return undefined;
    const text = (payload.content ?? []).filter((c) => c.type === "output_text" && typeof c.text === "string").map((c) => c.text).join("\n").trim();
    return text || undefined;
  } catch { return undefined; }
}

/** Result text placed in the caller's inbox: short, and honest when Codex gave no final message. */
export function resultSummary(taskId: string, message: string | undefined): string {
  const text = (message ?? "").trim();
  void taskId;
  return text || "The assigned work ended without a final message.";
}
