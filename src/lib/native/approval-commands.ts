/**
 * N5 commands: `tasks`, `approve`, `deny`, `allow`, `rules`, `revoke`. Approving, denying and setting rules need a
 * person at a terminal: an agent's shell has none, so an agent can never approve its own or another agent's work.
 */
import { createLocalStore, handleForProvider } from "./local-store";
import { deliverToCodex, realDeps, type DeliveryDeps } from "./codex-delivery";
import { isHumanContext, parseDuration } from "./approval-core";
import type { Task } from "./inbox-core";

export interface ApprovalIo {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Present only with a real terminal. */
  confirm?(question: string): Promise<boolean>;
  codexDeps?: DeliveryDeps;
}

/** A command counts as typed by a person only with a real terminal and no agent markers (see approval-core). */
export const isHuman = (io: Pick<ApprovalIo, "env" | "confirm">) => isHumanContext({ hasTerminal: !!io.confirm, env: io.env });

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

export function stateLabel(t: Task): string {
  if (t.approval === "pending") return "awaiting approval";
  if (t.approval === "denied") return "denied";
  if (t.approval === "expired") return "lapsed";
  if (t.delivery?.state === "done") return "answered";
  if (t.delivery?.state === "queued") return "pushed into the session";
  if (t.delivery?.state === "failed") return "push failed, waits in the inbox";
  return t.deliveredAt ? "delivered" : "in the inbox";
}

export const HUMAN_ONLY = "That needs a person at a terminal. An agent cannot approve tasks or set rules, so it cannot approve its own or another agent's work. Open a terminal yourself and run the same command.";

export function runTasks(io: ApprovalIo, storeRoot: string): number {
  const store = createLocalStore(storeRoot);
  store.sweepExpired();
  const tasks = store.snapshot().tasks.slice(-20).reverse();
  if (tasks.length === 0) { io.out("No tasks yet."); return 0; }
  for (const t of tasks) io.out(`${t.id}  @${t.from} -> @${t.to}  [${stateLabel(t)}]  ${oneLine(t.goal, 70)}`);
  const waiting = tasks.filter((t) => t.approval === "pending");
  if (waiting.length) io.out(`${waiting.length} waiting for you: m9r-cli approve <id>  or  m9r-cli deny <id>`);
  return 0;
}

export async function runDecision(io: ApprovalIo, storeRoot: string, decision: "approved" | "denied", id: string | undefined, yes: boolean): Promise<number> {
  if (!id) { io.err(`Usage: m9r-cli ${decision === "approved" ? "approve" : "deny"} <task id>`); return 1; }
  if (!isHuman(io)) { io.err(HUMAN_ONLY); return 1; }
  const store = createLocalStore(storeRoot);
  store.sweepExpired();
  const task = store.getTask(id.toUpperCase());
  if (!task) { io.err(`No task ${id}. See: m9r-cli tasks`); return 1; }
  if (task.approval !== "pending") { io.out(`${task.id} is not waiting for approval (${stateLabel(task)}).`); return 0; }
  io.out(`${task.id}: @${task.from} asks @${task.to}: ${oneLine(task.goal, 300)}`);
  if (!yes && !(await io.confirm?.(decision === "approved" ? "Approve this task?" : "Deny this task?"))) { io.out("Nothing was changed."); return 1; }
  store.setApproval(task.id, decision);
  if (decision === "denied") { io.out(`Denied ${task.id}. It will not be delivered.`); return 0; }
  io.out(`Approved ${task.id}.`);
  if (task.to === "codex") {
    const outcome = await deliverToCodex(store, task.id, io.codexDeps ?? realDeps(io.env));
    if (outcome.state === "queued") io.out("Pushed into the Codex session; it runs there now.");
    else if (outcome.state === "failed") io.out(`Could not push it now (${outcome.reason}); it will show at Codex's next prompt.`);
  } else io.out(`It appears at @${task.to}'s next prompt.`);
  return 0;
}

export function runAllow(io: ApprovalIo, storeRoot: string, from: string | undefined, to: string | undefined, duration: string | undefined): number {
  if (!from || !to) { io.err("Usage: m9r-cli allow @<from> @<to> [--for 30m|2h|1d]"); return 1; }
  if (!isHuman(io)) { io.err(HUMAN_ONLY); return 1; }
  const ttlMs = parseDuration(duration);
  if (ttlMs == null) { io.err("Use a duration like 30m, 2h or 1d (at most one day)."); return 1; }
  const rule = createLocalStore(storeRoot).addRule({ from: handleForProvider(from.replace(/^@/, "")), to: handleForProvider(to.replace(/^@/, "")), ttlMs });
  io.out(`Rule ${rule.id}: @${rule.from} may hand work to @${rule.to} without asking until ${rule.expiresAt}.`);
  io.out(`Protected actions (deleting, deploying or publishing, secrets, payments, messages to other people) still ask every time. Undo: m9r-cli revoke ${rule.id}`);
  return 0;
}

/** Lists the sessions M9R has seen for an agent, so a task can be aimed with `send --session`. */
export function runSessions(io: ApprovalIo, storeRoot: string, handle: string | undefined): number {
  const who = handleForProvider((handle ?? "codex").replace(/^@/, ""));
  const sessions = createLocalStore(storeRoot).sessionsFor(who);
  if (sessions.length === 0) { io.out(`No @${who} sessions seen yet.`); return 0; }
  for (const s of sessions) io.out(`${s.sessionId}  last seen ${s.lastSeenAt}  ${s.cwd ?? ""}`);
  if (sessions.length > 1) io.out(`Aim a task at one: m9r-cli send @${who} --session <first characters of the id> "..."`);
  return 0;
}

/** Lists every session M9R knows for an agent, as JSON, for the pill's link picker. Not human-formatted, unlike `sessions`. */
export function runSessionsJson(io: ApprovalIo, storeRoot: string, handle: string | undefined): number {
  const who = handleForProvider((handle ?? "codex").replace(/^@/, ""));
  const store = createLocalStore(storeRoot);
  const sessions = store.sessionsFor(who).map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, lastSeenAt: s.lastSeenAt }));
  io.out(JSON.stringify(sessions));
  return 0;
}

/** Links one session to another so a task from it always goes to that partner, overriding any guess. Symmetric: linking A to B also lets B reach A. */
export function runLink(io: ApprovalIo, storeRoot: string, fromHandle: string | undefined, fromSession: string | undefined, toHandle: string | undefined, toSession: string | undefined): number {
  if (!isHuman(io)) { io.err(HUMAN_ONLY); return 1; }
  if (!fromHandle || !fromSession || !toHandle || !toSession) { io.err('Usage: m9r-cli link --from-handle @agent --from-session <id> --to-handle @agent --to-session <id>'); return 1; }
  const store = createLocalStore(storeRoot);
  const a = { handle: handleForProvider(fromHandle.replace(/^@/, "")), sessionId: fromSession };
  const b = { handle: handleForProvider(toHandle.replace(/^@/, "")), sessionId: toSession };
  const link = store.setLink(a, b, "picked");
  io.out(`Linked ${link.id}: @${a.handle} (${a.sessionId.slice(0, 8)}) <-> @${b.handle} (${b.sessionId.slice(0, 8)}). Undo: m9r-cli unlink ${link.id}`);
  return 0;
}

export function runUnlink(io: ApprovalIo, storeRoot: string, id: string | undefined): number {
  if (!isHuman(io)) { io.err(HUMAN_ONLY); return 1; }
  if (!id) { io.err("Usage: m9r-cli unlink <link id>"); return 1; }
  createLocalStore(storeRoot).removeLink(id.toUpperCase());
  io.out(`Removed link ${id.toUpperCase()}.`);
  return 0;
}

export function runRules(io: ApprovalIo, storeRoot: string): number {
  const rules = createLocalStore(storeRoot).activeRules();
  if (rules.length === 0) { io.out("No standing rules."); return 0; }
  for (const r of rules) io.out(`${r.id}  @${r.from} -> @${r.to}  until ${r.expiresAt}`);
  return 0;
}

export function runRevoke(io: ApprovalIo, storeRoot: string, id: string | undefined): number {
  if (!id) { io.err("Usage: m9r-cli revoke <rule id>"); return 1; }
  if (!isHuman(io)) { io.err(HUMAN_ONLY); return 1; }
  io.out(createLocalStore(storeRoot).revokeRule(id.toUpperCase()) ? `Revoked ${id}.` : `No rule ${id}. See: m9r-cli standing`);
  return 0;
}
