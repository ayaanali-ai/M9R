/**
 * N5 commands: `tasks`, `approve`, `deny`, `allow`, `rules`, `revoke`. Approving, denying and setting rules need a
 * person at a terminal: an agent's shell has none, so an agent can never approve its own or another agent's work.
 */
import { createLocalStore, handleForProvider, MAX_LOCAL_EVENT_HISTORY, MAX_STAGE_TIMING_EVENTS_PER_TASK } from "./local-store";
import { deliverToCodex, realDeps, type DeliveryDeps } from "./codex-delivery";
import { isHumanContext, lapsedPending, parseDuration, PENDING_TTL_MS } from "./approval-core";
import { summarizeStageTimingEvents, summarizeTaskThinkTime, type Task } from "./inbox-core";

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
  if (t.retiredAt) return "retired from live delivery; history retained";
  // The receipt describes execution; delivery only describes transport. A turn
  // can pause or fail while its earlier transport receipt remains queued.
  if (t.receipt?.state === "canceled") return "canceled";
  if (t.receipt?.state === "failed") return "failed";
  if (t.receipt?.state === "paused") return t.completion?.status === "incomplete" ? "paused; incomplete" : "paused";
  if (t.receipt?.state === "completed") return "answered";
  if (t.receipt?.state === "uncertain") return "outcome uncertain; inspect before retrying";
  if (t.receipt?.state === "retryable") return "retryable; waiting for delivery";
  if (t.completion?.status === "incomplete") return "paused; incomplete";
  if (t.completion?.status === "completed" || t.resultSummary !== undefined || t.lifecycle?.state === "completed" || t.delivery?.state === "done") return "answered";
  if (t.lifecycle?.state === "failed") return "failed";
  if (t.delivery?.state === "queued") return "accepted by the session; waiting for a result";
  if (t.delivery?.state === "sending") return "being sent to the session";
  if (t.delivery?.state === "deferred") return "waiting for the preceding task; resumes automatically";
  if (t.delivery?.state === "uncertain") return "delivery could not be confirmed; it will not be resent automatically";
  if (t.delivery?.state === "failed") return "push failed, waits in the inbox";
  return t.deliveredAt ? "delivered" : "in the inbox";
}

export const HUMAN_ONLY = "That needs a person at a terminal. An agent cannot approve tasks or set rules, so it cannot approve its own or another agent's work. Open a terminal yourself and run the same command.";

/** Dry-run by default. Applying only expires stale requests; their task and audit history are deliberately retained. */
export async function runPurgeStaleApprovals(io: ApprovalIo, storeRoot: string, apply: boolean, now: () => Date = () => new Date()): Promise<number> {
  const store = createLocalStore(storeRoot, { now });
  const tasks = store.snapshot().tasks;
  const pendingCount = tasks.filter((task) => task.approval === "pending").length;
  const stale = lapsedPending(tasks, now(), PENDING_TTL_MS);
  if (stale.length === 0) { io.out(`No stale pending approvals found (${pendingCount} still within the 24-hour window); nothing changed.`); return 0; }
  if (!apply) {
    io.out(`Dry run: ${stale.length} stale approval${stale.length === 1 ? "" : "s"} (of ${pendingCount} pending) would be marked expired. No state changed. To apply: m9r-cli approvals purge --apply`);
    return 0;
  }
  if (!isHuman(io) || !io.confirm) { io.err(`${HUMAN_ONLY} The purge apply step also requires an interactive confirmation.`); return 1; }
  if (!(await io.confirm(`Mark ${stale.length} stale approval(s) expired? Their task and audit history will be retained.`))) {
    io.out("Cancelled. Nothing was changed.");
    return 1;
  }
  const expired = store.sweepExpired(PENDING_TTL_MS);
  io.out(`Expired ${expired.length} stale approval(s). Task and audit history were retained.`);
  return 0;
}

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

/** Read-only, owner-terminal export of the evidence M9R actually retained for one task. */
export function runTaskLog(io: ApprovalIo, storeRoot: string, rawId: string | undefined): number {
  const id = rawId?.trim().toUpperCase();
  if (!id || !/^T[0-9]{1,12}$/.test(id)) {
    io.err("Usage: m9r-cli task-log <task id>  (writes a JSON evidence bundle to stdout)");
    return 1;
  }
  if (!isHuman(io)) {
    io.err("Task evidence is available only to the owner at a terminal; provider agents cannot read local task logs.");
    return 1;
  }

  const store = createLocalStore(storeRoot);
  const snapshot = store.snapshot();
  const task = snapshot.tasks.find((candidate) => candidate.id === id);
  if (!task) {
    io.err(`No task ${id} exists in this M9R local store.`);
    return 1;
  }

  const stageTiming = task.stageTiming ?? [];
  const stageTimingSummary = task.stageTimingSummary ?? summarizeStageTimingEvents(stageTiming);
  const correlatedStoreEvents = snapshot.events.filter((event) => event.taskId === task.id);
  const report = {
    schema: "m9r.task-evidence.v1",
    generatedAt: new Date().toISOString(),
    task: {
      id: task.id,
      createdAt: task.createdAt,
      deliveredAt: task.deliveredAt,
      from: task.from,
      to: task.to,
      origin: task.origin,
      instruction: task.goal,
      instructionTruncated: task.goalTruncated,
      approval: task.approval,
      delivery: task.delivery && {
        transport: task.delivery.transport,
        state: task.delivery.state,
        attempts: task.delivery.attempts,
        claimedAt: task.delivery.claimedAt,
        queuedAt: task.delivery.queuedAt,
        uncertainAt: task.delivery.uncertainAt,
        failedAt: task.delivery.failedAt,
        error: task.delivery.error,
        correlation: task.delivery.correlation,
      },
      deliveryHistory: task.deliveryHistory?.map((delivery) => ({
        transport: delivery.transport,
        state: delivery.state,
        attempts: delivery.attempts,
        claimedAt: delivery.claimedAt,
        queuedAt: delivery.queuedAt,
        uncertainAt: delivery.uncertainAt,
        failedAt: delivery.failedAt,
        error: delivery.error,
        correlation: delivery.correlation,
      })),
      lifecycle: task.lifecycle && {
        state: task.lifecycle.state,
        source: task.lifecycle.source,
        queuedAt: task.lifecycle.queuedAt,
        presentedAt: task.lifecycle.presentedAt,
        acknowledgedAt: task.lifecycle.acknowledgedAt,
        completedAt: task.lifecycle.completedAt,
        error: task.lifecycle.error,
      },
      receipt: task.receipt && {
        state: task.receipt.state,
        attempt: task.receipt.attempt,
        updatedAt: task.receipt.updatedAt,
        source: task.receipt.source,
        error: task.receipt.error,
        history: (task.receipt.history ?? []).map(({ state, at, attempt, source, basis, error }) => ({ state, at, attempt, source, basis, error })),
      },
      runtimeBuildIds: task.runtimeBuildIds ?? [],
      resultSummary: task.resultSummary,
      completion: task.completion,
    },
    stageTiming,
    stageTimingSummary,
    stageTimingSummaryStartedAt: task.stageTimingSummaryStartedAt ?? stageTiming[0]?.startedAt ?? null,
    timingBreakdown: summarizeTaskThinkTime({
      createdAt: task.createdAt,
      completedAt: task.lifecycle?.completedAt ?? task.completion?.updatedAt,
      stageTimingSummary,
    }),
    correlatedStoreEvents,
    retention: {
      stageTimingEvents: stageTiming.length,
      perTaskStageTimingLimit: MAX_STAGE_TIMING_EVENTS_PER_TASK,
      stageTimingMayBeTruncated: stageTiming.length >= MAX_STAGE_TIMING_EVENTS_PER_TASK,
      stageTimingSummaryMayBeIncomplete: task.stageTimingSummaryMayBeIncomplete ?? stageTiming.length >= MAX_STAGE_TIMING_EVENTS_PER_TASK,
      stageTimingSummaryEventCount: Object.values(stageTimingSummary).reduce((total, phase) => total + (phase?.count ?? 0), 0),
      correlatedStoreEvents: correlatedStoreEvents.length,
      globalEventHistoryLimit: MAX_LOCAL_EVENT_HISTORY,
      globalEventHistoryMayBeTruncated: snapshot.events.length >= MAX_LOCAL_EVENT_HISTORY,
      note: "Raw task-stage timing details are bounded; per-phase count, duration sum, maximum, and error totals continue after that detail cap. A summary backfilled from a legacy capped history is marked possibly incomplete. Timing details are redacted and length-bounded when stored. The store does not retain provider conversation transcripts, screenshots, or the broker process stderr stream; this export reports only evidence that was actually persisted.",
    },
  };
  io.out(JSON.stringify(report, null, 2));
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
