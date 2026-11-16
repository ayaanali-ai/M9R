import type { A2AMessage, A2AMessageKind, A2AProgressKind } from "./multiplayer-contract";

/**
 * Task, inbox and injection-format core for the native front door (design sections 6, 7, 9 and 12).
 * Pure functions only: no file, network or clock access, so the same code runs in a hook, the Node and a test.
 *
 * Token discipline is a hard rule here: everything injected into an agent's context is capped, delta-only, and a
 * pointer to retained task evidence through m9r_working_context, never a full transcript.
 */

/** The existing goal cap from the network spec. */
export const MAX_GOAL_CHARS = 2000;
export const MAX_RESULT_SUMMARY_CHARS = 400;
export const ENVELOPE_GOAL_CHARS = 600;
export const MAX_POINTERS = 12;
export const MAX_POINTER_CHARS = 200;
/** Native teammate exchanges are intentionally bounded; a new owner task is required after this depth. */
export const MAX_AGENT_REPLY_DEPTH = 8;
/** Proposed caps (design section 12); kept together so they can change without a release. */
export const CAPS = {
  cardTokens: 300,
  inboxItems: 3,
  inboxItemTokens: 200,
  cardOthers: 5,
} as const;

export const TRUNCATION_MARKER = " [truncated]";

export type Approval = "not_needed" | "pending" | "approved" | "denied" | "expired";
export type Origin = "human_typed" | "agent_initiated";
export type CoordinationCompletion = "pending" | "accepted" | "completed" | "failed";

/** Compact coordination metadata; task prose remains separate and is never duplicated into activity events. */
export interface TaskCoordination {
  intent: "request" | "message";
  target: string;
  conversationId?: string;
  messageId?: string;
  replyToMessageId?: string;
  dependencyTaskId?: string;
  completion: CoordinationCompletion;
}

/** Durable link from an inbox delivery back to its structured team conversation. */
export interface TaskA2ALink {
  conversationId: string;
  messageId: string;
  senderAgentId: string;
  recipientAgentId: string;
  replyDepth: number;
  kind: A2AMessageKind;
  summary: string;
  taskId?: string;
  replyToMessageId?: string;
  progressFingerprint?: string;
  progressKind?: A2AProgressKind;
  /** Sanitized transport envelope retained so retries remain idempotent after owner-broker restart. */
  wireMessage?: A2AMessage;
}

/**
 * Provider-neutral evidence for one task. Transport state remains on
 * `TaskDelivery` for adapter-specific details; this is the single receipt
 * contract every delivery path updates.
 */
export type TaskReceiptState = "accepted" | "dispatched" | "provider_received" | "started"
  | "completed" | "paused" | "canceled" | "failed" | "retryable" | "uncertain";
export type TaskReceiptSource = "owner-broker" | "provider-transport" | "provider-session" | "prompt" | "system";
export type TaskReceiptBasis = "observed" | "inferred";

export interface TaskReceiptEvent {
  state: TaskReceiptState;
  at: string;
  attempt: number;
  source: TaskReceiptSource;
  basis: TaskReceiptBasis;
  sessionId?: string;
  error?: string;
}

export interface TaskReceipt {
  state: TaskReceiptState;
  attempt: number;
  updatedAt: string;
  source: TaskReceiptSource;
  sessionId?: string;
  error?: string;
  history: TaskReceiptEvent[];
}

export interface TaskReceiptTransition {
  state: TaskReceiptState;
  at: string;
  attempt?: number;
  source?: TaskReceiptSource;
  basis?: TaskReceiptBasis;
  sessionId?: string;
  error?: string;
}

const MAX_TASK_RECEIPT_EVENTS = 32;
const RECEIPT_TRANSITIONS: Readonly<Record<TaskReceiptState, readonly TaskReceiptState[]>> = {
  accepted: ["dispatched", "provider_received", "started", "completed", "paused", "canceled", "failed", "retryable", "uncertain"],
  dispatched: ["provider_received", "started", "completed", "paused", "canceled", "failed", "retryable", "uncertain"],
  provider_received: ["started", "completed", "paused", "canceled", "failed", "uncertain"],
  started: ["completed", "paused", "canceled", "failed", "uncertain"],
  paused: ["canceled"],
  retryable: ["dispatched", "canceled", "failed"],
  uncertain: ["completed", "canceled"],
  failed: ["completed", "canceled", "retryable"],
  completed: [],
  canceled: [],
};

function receiptEventEqual(left: TaskReceiptEvent, right: TaskReceiptEvent): boolean {
  return left.state === right.state
    && left.attempt === right.attempt
    && left.source === right.source
    && left.basis === right.basis
    && left.sessionId === right.sessionId
    && left.error === right.error;
}

function pushReceiptEvent(receipt: TaskReceipt, event: TaskReceiptEvent): TaskReceipt {
  const previous = receipt.history.at(-1);
  if (previous && receiptEventEqual(previous, event)) return receipt;
  return {
    ...receipt,
    state: event.state,
    attempt: Math.max(receipt.attempt, event.attempt),
    updatedAt: event.at,
    source: event.source,
    ...(event.sessionId ? { sessionId: event.sessionId } : receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
    ...(event.error ? { error: event.error } : event.state === "completed" || event.state === "paused" || event.state === "canceled" ? { error: undefined } : {}),
    history: [...receipt.history, event].slice(-MAX_TASK_RECEIPT_EVENTS),
  };
}

export function initialTaskReceipt(at: string): TaskReceipt {
  const event: TaskReceiptEvent = { state: "accepted", at, attempt: 0, source: "owner-broker", basis: "observed" };
  return { state: event.state, attempt: 0, updatedAt: at, source: event.source, history: [event] };
}

/**
 * Advances the canonical receipt without allowing an adapter to move a task
 * backwards or silently turn an uncertain send into a retry. A later result
 * is allowed to close a failed/uncertain transport because that result is
 * positive evidence that the provider did receive and start the work; the
 * missing intermediate states are marked inferred, never presented as raw
 * provider observations.
 */
export function transitionTaskReceipt(current: TaskReceipt | undefined, transition: TaskReceiptTransition): TaskReceipt {
  let receipt = current ?? initialTaskReceipt(transition.at);
  if (receipt.state === transition.state
    && (transition.error === undefined || transition.error === receipt.error)
    && (transition.sessionId === undefined || transition.sessionId === receipt.sessionId)
    && (transition.attempt === undefined || transition.attempt <= receipt.attempt)) return receipt;

  const attempt = Math.max(receipt.attempt, transition.attempt ?? receipt.attempt);
  const source = transition.source ?? receipt.source;
  const basis = transition.basis ?? "observed";
  const event = (state: TaskReceiptState, eventBasis: TaskReceiptBasis = basis): TaskReceiptEvent => ({
    state,
    at: transition.at,
    attempt,
    source,
    basis: eventBasis,
    ...(transition.sessionId ? { sessionId: transition.sessionId } : receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
    ...(transition.error && (state === transition.state || state === "failed" || state === "uncertain" || state === "retryable") ? { error: transition.error } : {}),
  });

  if (transition.state === "completed" && receipt.state !== "completed" && receipt.state !== "canceled" && receipt.state !== "paused") {
    if (receipt.state !== "provider_received") receipt = pushReceiptEvent(receipt, event("provider_received", "inferred"));
    if (receipt.state !== "started") receipt = pushReceiptEvent(receipt, event("started", "inferred"));
    return pushReceiptEvent(receipt, event("completed"));
  }

  if (transition.state === receipt.state) return pushReceiptEvent(receipt, event(transition.state));
  if (receipt.state === "completed" || receipt.state === "canceled") return receipt;
  if (!RECEIPT_TRANSITIONS[receipt.state].includes(transition.state)) return receipt;
  return pushReceiptEvent(receipt, event(transition.state));
}

/** A durable phase boundary for one request handled by the native desktop stage. */
export type StageTimingPhase = "queue_wait" | "prepare" | "launch" | "action" | "close" | "stop"
  | "launch-preflight" | "stage-recovery"
  | "sdk-load" | "host-connect" | "runtime-acquire" | "session-start" | "cursor-motion" | "cursor-position" | "cursor-visible" | "cursor-overlay" | "foreground-lease" | "background-dispatch"
  | "window-capture" | "accessibility-read" | "target-resolution" | "input-dispatch" | "post-action-observation"
  | "launch-discovery"
  | "provider-acceptance" | "first-visible-action" | "completion" | "post-action-wrapup" | "inter-action-think";

/**
 * The single source of truth for every valid phase name, used by local-store's
 * recordStageTiming to validate incoming events. A hand-duplicated literal list
 * there previously had to be updated in lockstep with the type above and
 * silently fell behind twice -- "post-action-wrapup" and "inter-action-think"
 * were both valid StageTimingPhase values that recordStageTiming rejected
 * outright, so every call recording them returned false and the event was
 * dropped before ever reaching pendingStageTiming, with no error surfaced
 * anywhere (timing writes are deliberately best-effort/silent). Deriving the
 * validator from this one array instead of a second list closes that class of
 * bug for any phase added from here on.
 */
export const ALL_STAGE_TIMING_PHASES: readonly StageTimingPhase[] = [
  "queue_wait", "prepare", "launch", "action", "close", "stop",
  "launch-preflight", "stage-recovery",
  "sdk-load", "host-connect", "runtime-acquire", "session-start", "cursor-motion", "cursor-position", "cursor-visible", "cursor-overlay", "foreground-lease", "background-dispatch",
  "window-capture", "accessibility-read", "target-resolution", "input-dispatch", "post-action-observation",
  "launch-discovery",
  "provider-acceptance", "first-visible-action", "completion", "post-action-wrapup", "inter-action-think",
];

/**
 * Timing is deliberately kept on the task record so a later result or audit can reconcile
 * the complete turn without depending on process stderr or a live broker. It contains no
 * task text, credentials, window identifiers, or desktop pixels. Post-action observation
 * measures a fresh capture for the agent; it does not claim the app accepted the action.
 */
export interface StageTimingEvent {
  phase: StageTimingPhase;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  operationId?: string;
  /** Runtime stage correlation label; it is an M9R-generated name, not a window or session id. */
  stageName?: string;
  /** Whether the driver reused a warm runtime/capture for this phase, when reported. */
  cached?: boolean;
  detail?: string;
}

/** Bounded per-phase totals preserve whole-task latency evidence after raw events roll over. */
export interface StageTimingAggregate {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
}

export type StageTimingSummary = Partial<Record<StageTimingPhase, StageTimingAggregate>>;

export function addStageTimingToSummary(summary: StageTimingSummary, event: StageTimingEvent): StageTimingSummary {
  const previous = summary[event.phase];
  const validCount = Number.isSafeInteger(previous?.count) && (previous?.count ?? 0) >= 0;
  const validTotal = Number.isFinite(previous?.totalDurationMs) && (previous?.totalDurationMs ?? -1) >= 0;
  const validMax = Number.isFinite(previous?.maxDurationMs) && (previous?.maxDurationMs ?? -1) >= 0;
  const validErrors = Number.isSafeInteger(previous?.errorCount) && (previous?.errorCount ?? 0) >= 0;
  const count = validCount ? previous!.count : 0;
  const previousTotal = validTotal ? previous!.totalDurationMs : 0;
  const total = previousTotal + event.durationMs;
  const boundedTotal = Math.min(Number.MAX_SAFE_INTEGER, Number.isFinite(total) ? total : Number.MAX_SAFE_INTEGER);
  summary[event.phase] = {
    count: Math.min(Number.MAX_SAFE_INTEGER, count + 1),
    totalDurationMs: Math.round(boundedTotal * 100) / 100,
    maxDurationMs: Math.max(validMax ? previous!.maxDurationMs : 0, event.durationMs),
    errorCount: Math.min(Number.MAX_SAFE_INTEGER, (validErrors ? previous!.errorCount : 0) + (event.status === "error" ? 1 : 0)),
  };
  return summary;
}

export function summarizeStageTimingEvents(events: readonly StageTimingEvent[]): StageTimingSummary {
  const summary: StageTimingSummary = {};
  for (const event of events) addStageTimingToSummary(summary, event);
  return summary;
}

/**
 * The phases a timedStagePhase() call wraps end-to-end: each one spans the whole time a
 * desktop-stage request spent in that phase, including every finer sub-phase recorded inside it
 * (e.g. "action" already contains "input-dispatch", "accessibility-read", "cursor-motion", ...).
 * Summing these six is real, non-overlapping M9R-side time; summing every StageTimingPhase would
 * double-count every sub-phase against its own parent.
 */
export const TOP_LEVEL_STAGE_TIMING_PHASES: readonly StageTimingPhase[] = ["queue_wait", "prepare", "launch", "action", "close", "stop"];

export interface TaskThinkTimeBreakdown {
  /** Wall-clock span from task creation to task completion. */
  totalElapsedMs: number;
  /** Sum of the top-level (non-overlapping) stage-timing phases: real M9R dispatch/infra time. */
  m9rInfraMs: number;
  /** totalElapsedMs minus m9rInfraMs, floored at 0. Not a direct measurement -- the remainder
   *  after subtracting every M9R-side phase we instrument. On a real task this is dominated by
   *  the agent provider's own reasoning time between dispatched actions, which M9R does not (and
   *  should not claim to) speed up; it can also include provider-side network/queueing time M9R
   *  has no visibility into. Treat it as "time not accounted for by M9R's own pipeline," not as
   *  a verified measurement of model think time specifically. */
  inferredNonInfraMs: number;
  /** m9rInfraMs as a share of totalElapsedMs, 0-100. */
  m9rInfraSharePercent: number;
}

/**
 * Splits a finished task's total wall-clock time into "M9R's own instrumented dispatch work" vs.
 * "everything else" (overwhelmingly the agent provider's own think time on a real task). Returns
 * null for a task with no completion timestamp yet (the total span is not closed) or where
 * completion is recorded before creation (clock skew / malformed data -- never report a negative
 * duration as if it were real).
 */
export function summarizeTaskThinkTime(input: { createdAt: string; completedAt: string | undefined; stageTimingSummary: StageTimingSummary | undefined }): TaskThinkTimeBreakdown | null {
  if (!input.completedAt) return null;
  const startedMs = Date.parse(input.createdAt);
  const endedMs = Date.parse(input.completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) return null;
  const totalElapsedMs = endedMs - startedMs;
  const summary = input.stageTimingSummary ?? {};
  const m9rInfraMs = TOP_LEVEL_STAGE_TIMING_PHASES.reduce((total, phase) => total + (summary[phase]?.totalDurationMs ?? 0), 0);
  const boundedInfraMs = Math.min(m9rInfraMs, totalElapsedMs);
  return {
    totalElapsedMs,
    m9rInfraMs: Math.round(boundedInfraMs * 100) / 100,
    inferredNonInfraMs: Math.round((totalElapsedMs - boundedInfraMs) * 100) / 100,
    m9rInfraSharePercent: totalElapsedMs > 0 ? Math.round((boundedInfraMs / totalElapsedMs) * 10000) / 100 : 0,
  };
}

/** Canonical inbox key: tolerate a single mention marker and provider-handle casing. */
export function normalizeHandle(handle: string): string {
  return (handle.startsWith("@") ? handle.slice(1) : handle).toLowerCase();
}

/** M9R-owned handoff state. Contains no provider conversation or resume IDs. */
export interface LogicalTaskContext {
  workId: string;
  planRevision: number;
  state: "active" | "paused";
  control: "new-task" | "continuation" | "redirect";
  originalObjective: string;
  latestInstruction: string;
  priorOutcome?: string;
  previousTaskId?: string;
  supersededByTaskId?: string;
  remainingWork?: string[];
}

export interface Task {
  id: string;
  /** Monotonic per-inbox sequence; the cursor is the highest seq an agent has been shown. */
  seq: number;
  from: string;
  to: string;
  goal: string;
  goalTruncated: boolean;
  logicalContext?: LogicalTaskContext;
  /** Latest bounded agent-authored working snapshot; original evidence remains on task records. */
  workingContext?: import("./task-working-context").WorkingContextRecord;
  /** Bounded task-scoped provider reports. Missing counters/costs remain unknown. */
  providerUsage?: { samples: import("./provider-usage-core").TaskProviderUsageSample[]; droppedSamples: number };
  completion?: { status: "completed" | "incomplete"; remainingWork: string[]; summary: string; updatedAt: string };
  pointers: string[];
  origin: Origin;
  approval: Approval;
  replyDepth: number;
  idempotencyKey: string;
  createdAt: string;
  /** Set when the task was first shown to its target agent. */
  deliveredAt?: string;
  /** Which trusted path first delivered it. Older persisted tasks have no marker. */
  deliverySource?: "prompt" | "push";
  resultSummary?: string;
  /** Set when the sender was first shown the result (once). */
  resultShownAt?: string;
  /** Set when the user cleared it from the overlay's "needs you" list. Hides it there; changes nothing about delivery. */
  dismissedAt?: string;
  /** Permanently removed from live delivery; history and transport evidence remain. */
  retiredAt?: string;
  /** Native push (N2): how far pushing this task into the target session got. Absent for plain inbox tasks. */
  delivery?: TaskDelivery;
  /** Bounded transport transition evidence, independent of the final task result. */
  deliveryHistory?: TaskDelivery[];
  /** Durable target-session receipt; unlike a cursor this records what was actually presented. */
  lifecycle?: TaskLifecycle;
  /** Provider-neutral delivery receipt; old state files may not have this field and are backfilled on mutation. */
  receipt?: TaskReceipt;
  /** Verified M9R runtime build ids that actually executed one or more turns for this task. */
  runtimeBuildIds?: string[];
  /** Working directory of the sender; used to pick the target's session when several are open. */
  cwd?: string;
  /** Session id (or unique prefix) the sender pinned, so a push never has to guess. */
  targetSession?: string;
  /** The sender's own session (a Codex thread id, say), so the answer can be pushed back to exactly that session. */
  fromSession?: string;
  /** System-generated result reply for this task; prevents result messages from recursively creating replies. */
  replyToTaskId?: string;
  /** Internal authorization lineage; never included in provider-facing task text. */
  parentTaskId?: string;
  /** Set when one owner message addresses several agents at once; shared across every resulting per-recipient
   * task so a later teammate delegation can recognize the recipient already has equivalent work in flight. */
  broadcastId?: string;
  /** Compact A2A state used for dedupe/acknowledgement; full prose remains in `goal`. */
  coordination?: TaskCoordination;
  /** Structured teammate-message identity, persisted with the durable inbox delivery. */
  a2a?: TaskA2ALink;
  /** The session the task was shown in (its inbox delivery), so its answer is read from that session's transcript. */
  deliveredSession?: string;
  /** Set when the answer was pushed back into the sender's session. */
  answerPushedAt?: string;
  /** Explicitly selected structured answer; retained so result retries cannot create another reply. */
  resultReplyMessageId?: string;
  /** Durable, bounded phase timings for native desktop-stage requests. */
  stageTiming?: StageTimingEvent[];
  /** Per-phase totals cover the entire task even when `stageTiming` raw details reach their cap. */
  stageTimingSummary?: StageTimingSummary;
  /** First event included in the durable summary. */
  stageTimingSummaryStartedAt?: string;
  /** True when a legacy capped raw history prevented backfilling the complete summary. */
  stageTimingSummaryMayBeIncomplete?: boolean;
}

export interface TaskDelivery {
  /** A resumed CLI process does not prove the owner's visible chat window updated. */
  transport?: "claude-resume" | "opencode-session-api" | "codex-queue";
  /** `sending` is a one-time claim; `queued` is provider acceptance, never proof the agent started work. */
  state: "sending" | "queued" | "uncertain" | "failed" | "done" | "deferred";
  attempts: number;
  threadId?: string;
  claimedAt?: string;
  queuedAt?: string;
  uncertainAt?: string;
  failedAt?: string;
  error?: string;
  /** New adapters report an exact task outcome; marker inference is legacy-only. */
  correlation?: "internal-context";
}

/**
 * Human-readable lifecycle evidence for a task. Delivery state answers
 * "did the transport accept it?"; lifecycle answers "what did the target
 * session actually receive/finish?" Keeping both prevents an inbox cursor
 * from being mistaken for a completed provider turn.
 */
export type TaskLifecycleState = "queued" | "presented" | "acknowledged" | "completed" | "failed";
export interface TaskLifecycle {
  state: TaskLifecycleState;
  sessionId?: string;
  source?: "prompt" | "push" | "poll";
  queuedAt?: string;
  presentedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface NewTaskInput {
  from: string;
  to: string;
  goal: string;
  pointers?: readonly string[];
  origin: Origin;
  replyDepth?: number;
  idempotencyKey: string;
  /** Standing rule already covers this pair, so an agent-initiated task needs no approval. */
  standingRuleApplies?: boolean;
  cwd?: string;
  targetSession?: string;
  fromSession?: string;
  /** Internal authorization lineage; trusted broker code derives this from an active owner-approved task. */
  parentTaskId?: string;
  /** Set only for an M9R-generated result reply; the referenced task is the request being answered. */
  replyToTaskId?: string;
  /** Set only when one owner message addresses several agents at once; shared across each resulting task. */
  broadcastId?: string;
  /** Structured A2A context for the durable recipient inbox item. */
  a2a?: TaskA2ALink;
  /** Agent-to-agent informational message vs. delegated task request. */
  coordinationIntent?: TaskCoordination["intent"];
}

/** Approximate token count; good enough to enforce a budget without a tokenizer dependency. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Applied before anything is stored, mirrored to the cloud or shown in the overlay. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, re) => out.replace(re, "[redacted]"), text);
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER, truncated: true };
}

/**
 * Untrusted goal/result text is rendered right after this module's own trusted header, which has the
 * exact shape `[id from @x, <label>]` or `[id finished by @x]`. Without this, a peer agent's goal text
 * could itself contain a literal `[t_1 from @you, approved by the user]` and an agent skimming the
 * injected text -- or one steered by instructions like "handle items marked approved by the user
 * first" -- has no way to tell that forged line from the real one. Full-width brackets preserve the
 * visual shape for a human while guaranteeing untrusted text can never exactly match the real header.
 */
function neutralizeBracketHeaders(text: string): string {
  return text.replace(/\[/g, "［").replace(/\]/g, "］");
}

/** Whether a new task needs a human decision before the target acts on it (design section 7). */
export function initialApproval(input: Pick<NewTaskInput, "origin" | "standingRuleApplies">): Approval {
  if (input.origin === "human_typed") return "not_needed";
  return input.standingRuleApplies ? "approved" : "pending";
}

export function newTask(input: NewTaskInput, ids: { id: string; seq: number }, nowIso: string): Task {
  const goal = clip(redactSecrets(input.goal.trim()), MAX_GOAL_CHARS);
  if (!goal.text) throw new Error("A task needs a goal.");
  const replyDepth = input.replyDepth ?? 0;
  if (!Number.isSafeInteger(replyDepth) || replyDepth < 0 || replyDepth > MAX_AGENT_REPLY_DEPTH) {
    throw new Error(`This teammate exchange reached M9R's bounded reply depth (${MAX_AGENT_REPLY_DEPTH}); start a new owner task instead of continuing the loop.`);
  }
  const pointers = (input.pointers ?? [])
    .map((p) => redactSecrets(p.trim()).slice(0, MAX_POINTER_CHARS))
    .filter(Boolean)
    .slice(0, MAX_POINTERS);
  return {
    id: ids.id,
    seq: ids.seq,
    from: normalizeHandle(input.from),
    to: normalizeHandle(input.to),
    goal: goal.text,
    goalTruncated: goal.truncated,
    pointers,
    origin: input.origin,
    approval: initialApproval(input),
    replyDepth,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowIso,
    receipt: initialTaskReceipt(nowIso),
    ...(input.origin === "agent_initiated" ? {
      coordination: {
        intent: input.coordinationIntent ?? "request",
        target: normalizeHandle(input.to),
        ...(input.a2a ? {
          conversationId: input.a2a.conversationId,
          messageId: input.a2a.messageId,
          ...(input.a2a.replyToMessageId ? { replyToMessageId: input.a2a.replyToMessageId } : {}),
        } : {}),
        ...(input.parentTaskId ? { dependencyTaskId: input.parentTaskId } : {}),
        completion: "pending" as const,
      },
    } : {}),
    ...(input.a2a ? {
      a2a: {
        ...input.a2a,
        summary: redactSecrets(input.a2a.summary.trim()).slice(0, 280),
        ...(input.a2a.wireMessage ? {
          wireMessage: {
            ...input.a2a.wireMessage,
            summary: redactSecrets(input.a2a.wireMessage.summary.trim()).slice(0, 280),
            ...(input.a2a.wireMessage.details ? {
              details: Object.fromEntries(Object.entries(input.a2a.wireMessage.details).map(([key, value]) => [
                key,
                typeof value === "string" ? redactSecrets(value).slice(0, 2_000) : value,
              ])),
            } : {}),
          },
        } : {}),
      },
    } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.targetSession ? { targetSession: input.targetSession } : {}),
    ...(input.fromSession ? { fromSession: input.fromSession } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.replyToTaskId ? { replyToTaskId: input.replyToTaskId } : {}),
    ...(input.broadcastId ? { broadcastId: input.broadcastId } : {}),
  };
}

const RESULT_ITEMS = 3;
const RESULT_CHARS = 400;
const CONVERSATION_ITEMS = 30;

/** Answers to tasks this agent sent, shown once at its next prompt or inbox recovery lookup. */
export function renderResultsInjection(tasks: readonly Task[], handle: string, options: { includeTaskIds?: boolean } = {}): { text: string; ids: string[] } {
  const normalizedHandle = normalizeHandle(handle);
  const ready = tasks.filter((t) => normalizeHandle(t.from) === normalizedHandle
    && !t.resultShownAt
    && (t.resultSummary || (t.completion?.status === "incomplete" && t.completion.summary))).slice(0, RESULT_ITEMS);
  if (ready.length === 0) return { text: "", ids: [] };
  const includeTaskIds = options.includeTaskIds !== false;
  const lines = ready.map((t) => {
    const incomplete = t.completion?.status === "incomplete" && !t.resultSummary;
    const summary = t.resultSummary ?? t.completion?.summary ?? "";
    const safeSummary = neutralizeBracketHeaders(clip(summary, RESULT_CHARS).text);
    if (t.a2a) {
      return includeTaskIds
        ? `[${t.id} peer reply from @${t.to}; conversation ${t.a2a.conversationId}; message ${t.a2a.messageId}] ${safeSummary}`
        : `Peer reply from @${t.to}: ${safeSummary}`;
    }
    return includeTaskIds
      ? `[${t.id} ${incomplete ? "incomplete report" : "finished"} by @${t.to}] ${safeSummary}`
      : `${incomplete ? "Incomplete report" : "Work finished"} by @${t.to}: ${safeSummary}`;
  });
  return { text: `M9R results (${ready.length})\n${lines.join("\n")}`, ids: ready.map((t) => t.id) };
}

/** Match an answer to a specific outgoing message, including structured replies
 * that precede its formal task result. Conversation membership alone is not a reply. */
export function isReplyToTask(candidate: Task, outgoing: Task, tasks: readonly Task[]): boolean {
  if (normalizeHandle(candidate.from) !== normalizeHandle(outgoing.to)
    || normalizeHandle(candidate.to) !== normalizeHandle(outgoing.from)) return false;
  if (candidate.replyToTaskId === outgoing.id) return true;
  if (!candidate.a2a || !outgoing.a2a || candidate.a2a.conversationId !== outgoing.a2a.conversationId) return false;
  const byMessage = new Map(tasks.filter(task => task.a2a?.conversationId === outgoing.a2a!.conversationId)
    .map(task => [task.a2a!.messageId, task]));
  const seen = new Set<string>([candidate.a2a.messageId]);
  let parent = candidate.a2a.replyToMessageId;
  while (parent && !seen.has(parent)) {
    if (parent === outgoing.a2a.messageId) return true;
    seen.add(parent);
    parent = byMessage.get(parent)?.a2a?.replyToMessageId;
  }
  return false;
}

/** Render only the A2A messages this exact identity can see, without advancing inbox cursors. */
export function renderA2AConversation(
  tasks: readonly Task[],
  conversationId: string,
  identity: { handle: string; sessionId: string },
): { text: string; count: number; total: number } {
  const handle = normalizeHandle(identity.handle);
  const visible = tasks.filter((task) => task.a2a?.conversationId === conversationId
    && (normalizeHandle(task.to) === handle
      || (normalizeHandle(task.from) === handle && task.fromSession === identity.sessionId)))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.seq - right.seq);
  if (visible.length === 0) return { text: `No stored messages in conversation ${conversationId} are addressed to this agent or were sent by this session.`, count: 0, total: 0 };
  const messages = visible.slice(-CONVERSATION_ITEMS);
  const lines = messages.map((task) => {
    const link = task.a2a!;
    const reply = link.replyToMessageId ? ` reply-to ${link.replyToMessageId}` : "";
    const details = link.wireMessage?.details;
    const detailText = details && Object.keys(details).length > 0
      ? `\n  Details: ${neutralizeBracketHeaders(clip(JSON.stringify(details), RESULT_CHARS).text)}`
      : "";
    const outcome = task.resultSummary ? `\n  Result: ${neutralizeBracketHeaders(clip(task.resultSummary, RESULT_CHARS).text)}` : "";
    return `- [${link.kind}; ${link.messageId}${reply}; @${task.from} → @${task.to}; ${task.lifecycle?.state ?? "queued"}] ${neutralizeBracketHeaders(link.summary)}${detailText}${outcome}`;
  });
  const omitted = visible.length - messages.length;
  return {
    text: `M9R conversation ${conversationId} (${messages.length} of ${visible.length} visible messages${omitted ? `; showing the most recent ${CONVERSATION_ITEMS}` : ""}):\n${lines.join("\n")}`,
    count: messages.length,
    total: visible.length,
  };
}

/** Same key means the same task: a repeated send must not create or deliver a second one. */
export function findByIdempotencyKey(tasks: readonly Task[], to: string, key: string): Task | undefined {
  const normalizedTo = normalizeHandle(to);
  return tasks.find((t) => normalizeHandle(t.to) === normalizedTo && t.idempotencyKey === key);
}

export interface InjectionResult {
  text: string;
  includedIds: string[];
  /** Highest seq shown; store it as the cursor so the next injection is delta-only. */
  newCursor: number;
  omitted: number;
}

function approvalLabel(t: Task): string {
  if (t.approval === "pending") return "AWAITING THE USER'S APPROVAL, do not act on it yet";
  if (t.approval === "approved") return "approved by the user";
  return t.origin === "human_typed" ? "typed by the user" : "from another agent";
}

/**
 * The text a hook injects at the user's next prompt. Only tasks the agent has not been shown (seq above the cursor),
 * only ones it may see (denied and expired are hidden), at most CAPS.inboxItems, each at most CAPS.inboxItemTokens.
 * Returns an empty string when there is nothing new, so an idle inbox costs zero tokens.
 */
/**
 * How long an unanswered task stays eligible for injection. A session that starts days after a task was sent (or a new session
 * for the same handle) must never be handed the whole backlog as if it were fresh work; `M9R_INBOX_MAX_AGE_MINUTES` overrides.
 */
export const INBOX_MAX_AGE_MS = 30 * 60_000;
export function inboxMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.M9R_INBOX_MAX_AGE_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : INBOX_MAX_AGE_MS;
}

/**
 * One freshness predicate for every provider-delivery boundary. A task from
 * the future is also rejected: clock skew must never turn an untrusted or
 * malformed timestamp into work that bypasses the stale-work fence.
 */
export function isFreshInboxTask(createdAt: string, now = Date.now(), maxAge = inboxMaxAgeMs()): boolean {
  const createdMs = Date.parse(createdAt);
  const age = now - createdMs;
  return Number.isFinite(createdMs) && age >= 0 && age <= maxAge;
}

export interface InjectionOptions {
  /** Clock for the age limit; defaults to Date.now(). */
  now?: number;
  /** Oldest task still injected; defaults to INBOX_MAX_AGE_MS. Pass Infinity to disable (tests only). */
  maxAgeMs?: number;
  /** Most items to show; defaults to CAPS.inboxItems. An explicit inbox check may ask for more than the automatic hook. */
  items?: number;
  /** Longest goal shown per item; defaults to ENVELOPE_GOAL_CHARS. */
  itemChars?: number;
  /** Provider delivery only: pending work is held until approval instead of being presented or cursor-advanced. */
  includePending?: boolean;
  /** Provider delivery only: keep durable task ids in the store, not in ordinary provider prompt text. */
  includeTaskIds?: boolean;
}

export function renderInboxInjection(tasks: readonly Task[], cursor: number, options: InjectionOptions = {}): InjectionResult {
  const maxItems = options.items ?? CAPS.inboxItems;
  const goalChars = options.itemChars ?? ENVELOPE_GOAL_CHARS;
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? inboxMaxAgeMs();
  const includeTaskIds = options.includeTaskIds !== false;
  const eligible = tasks
    // A task claimed or pushed by a direct transport must not race a second provider route through the inbox.
    // A task that already has a result is finished, and one older than the age limit is history, not work to hand a new session.
    .filter((t) => !t.retiredAt && t.seq > cursor && t.approval !== "denied" && t.approval !== "expired"
      && t.receipt?.state !== "canceled" && t.receipt?.state !== "paused"
      && !["sending", "queued", "uncertain", "done"].includes(t.delivery?.state ?? "")
      && !t.resultSummary && isFreshInboxTask(t.createdAt, now, maxAge))
    .sort((a, b) => a.seq - b.seq);
  // Provider delivery must preserve inbox order. If an unapproved task is at
  // the frontier, do not skip over it and advance the cursor past it: approval
  // later must still make that exact task deliverable. The owner-facing
  // renderer keeps its historical default (includePending=true) so the
  // approval card remains visible.
  const firstPending = options.includePending === false
    ? eligible.find((task) => task.approval === "pending")
    : undefined;
  const visible = firstPending ? eligible.filter((task) => task.seq < firstPending.seq) : eligible;
  const shown = visible.slice(0, maxItems);
  if (shown.length === 0) return { text: "", includedIds: [], newCursor: cursor, omitted: 0 };
  const perItemChars = options.itemChars ? options.itemChars + 200 : CAPS.inboxItemTokens * 4;
  const lines = shown.map((t) => {
    // Human-originated work is authorized by the owner who typed the mention,
    // not by a synthetic @you agent. Keep that distinction provider-visible so
    // a connected agent cannot mistake the sender label for another M9R agent
    // or ask the owner to re-authorize an ordinary direct task.
    const sender = t.origin === "human_typed" ? "the owner" : `@${t.from}`;
    const head = t.a2a
      ? `[${t.id} peer message from ${sender}; conversation ${t.a2a.conversationId}; message ${t.a2a.messageId}${t.a2a.replyToMessageId ? ` replying to ${t.a2a.replyToMessageId}` : ""}] `
      : includeTaskIds ? `[${t.id} from ${sender}, ${approvalLabel(t)}] ` : `M9R work from ${sender}: `;
    const tail = includeTaskIds
      ? ` Stored evidence: m9r_working_context taskId=${t.id} action=evidence evidenceTaskId=${t.id}.`
      : " Recover stored task evidence with m9r_working_context action=evidence; text truncated at storage cannot be recovered there.";
    const room = Math.max(40, Math.min(goalChars, perItemChars - head.length - tail.length));
    // The pointer is only useful (and only safe to mention) when the text shown is not the whole goal.
    const shown = clip(t.goal, room);
    return head + neutralizeBracketHeaders(shown.text) + (shown.truncated || t.goalTruncated ? tail : "");
  });
  const omitted = visible.length - shown.length;
  const more = omitted > 0 ? ` (${omitted} more waiting: call inbox.)` : "";
  return {
    text: `${includeTaskIds ? "M9R inbox" : "M9R work"} (${shown.length} new)${more}\n${lines.join("\n")}${includeTaskIds ? "" : "\nWhen finished or blocked, call m9r_result with the concrete outcome."}`,
    includedIds: shown.map((t) => t.id),
    newCursor: shown[shown.length - 1].seq,
    omitted,
  };
}

export interface CardInput {
  handle: string;
  others: ReadonlyArray<{ handle: string; activity?: string }>;
  pendingCount: number;
  /** Tasks waiting for the user's yes (N5); the agent is told so it can say so. */
  awaitingApproval?: number;
  /** Only set when the folder really exists; otherwise the card says nothing about memory. */
  memoryDir?: string;
  /** Stable for this provider session; scopes M9R MCP calls to this verified identity. */
  identityToken?: string;
}

/** The once-per-session card: a handful of lines, pointers only, never memory content. */
export function renderSessionCard(input: CardInput): string {
  const others = input.others.slice(0, CAPS.cardOthers).map((o) => `@${o.handle}${o.activity ? ` (${o.activity.slice(0, 60)})` : ""}`);
  const lines = [
    `M9R connected as @${input.handle}.`,
    input.identityToken ? `M9R session token (for the M9R MCP server, "m9r_whoami" and friends; keep it out of anything you post publicly): ${input.identityToken}` : "",
    others.length ? `Active now: ${others.join(", ")}.` : "No other agents active.",
    input.pendingCount > 0 ? "M9R has incoming work; authorized work is delivered automatically when this session is ready." : "",
    input.awaitingApproval ? "Some M9R work is awaiting owner approval; do not act until M9R delivers it as authorized." : "",
    input.memoryDir ? `Earlier agent sessions on this project are indexed in ${input.memoryDir}/index.md; read a short summary there before re-deriving earlier work.` : "",
  ].filter(Boolean);
  const card = lines.join(" ");
  return approxTokens(card) <= CAPS.cardTokens ? card : clip(card, CAPS.cardTokens * 4).text;
}

/** The one line injected after a human-typed mention so the sending agent does not do the work itself. */
export function renderSentAck(taskId: string, to: string, includeTaskId = true): string {
  const reference = includeTaskId ? ` as task ${taskId}` : "";
  return `M9R already sent your message to @${to}${reference}, so @${to} will do it. Do not do that work yourself: tell the user it was sent to @${to}, and continue with anything else. The result will arrive in your inbox.`;
}

/**
 * Truthful delivery states for a mention the hook did NOT push live (only Codex receives a queue push).
 * A target with a live session picks the task up at its next prompt; a target with no session waits
 * until it connects. Both keep the do-not-do-it-yourself directive: the failure mode being fixed is the
 * sender believing "sent" means "being worked on right now".
 */
export function renderInboxAck(taskId: string, to: string, includeTaskId = true): string {
  const reference = includeTaskId ? ` as task ${taskId}` : "";
  return `M9R put your message to @${to} in their inbox${reference}; they pick it up at their next prompt, so it is not being worked on this instant. Do not do that work yourself: tell the user it was handed to @${to}, and continue with anything else. The result will arrive in your inbox.`;
}

/** Native resident adapters use the same no-polling contract as OpenCode. */
export function renderAutoDeliveryPendingAck(taskId: string, to: string, includeTaskId = true): string {
  const reference = includeTaskId ? ` task ${taskId}` : " work";
  return `M9R queued${reference} for @${to}'s active session. Its resident provider adapter will deliver the task directly without a manual inbox check; delivery is not confirmed until that session accepts it. Do not do that work yourself: tell the user it is queued for @${to}, and continue with anything else. The result will arrive in your inbox.`;
}

export function renderHeldAck(taskId: string, to: string, includeTaskId = true): string {
  const reference = includeTaskId ? ` as task ${taskId}` : "";
  return `M9R held your message to @${to}${reference} because @${to} has no active session right now; it reaches them when they connect. Do not do that work yourself: tell the user it is waiting for @${to}, and continue with anything else. The result will arrive in your inbox.`;
}

/**
 * Keeps the task list from growing forever (a live room can produce thousands of tasks; the file that holds them gets
 * rewritten whole on every write, so its size directly costs every save). Only a task that is fully done -- the target
 * has a recorded result that the sender has seen, or a delivered task was denied/expired. Pending approvals,
 * undelivered tasks, work without a result, and unread results are never touched, however old. Dismissing a
 * notification only hides it from the overlay; it does not complete the work.
 */
export function pruneTasks(tasks: readonly Task[], input: { maxCount: number; maxAgeMs: number; now: number; preserveIds?: ReadonlySet<string> }): Task[] {
  const resolved = (t: Task): boolean => {
    if (input.preserveIds?.has(t.id)) return false;
    if (!t.deliveredAt || t.approval === "pending") return false;
    const hasResult = t.resultSummary !== undefined;
    const terminalWithoutResult = t.approval === "denied" || t.approval === "expired";
    // Item #22, live 2026-11-13: of 169 real completed tasks in state.json, 165 had
    // never been marked shown -- some 17+ days old -- because resultShownAt is an
    // agent-to-agent inbox-read cursor (set when a SENDER agent later checks its own
    // outbox for a reply), which has no equivalent step for an owner-typed task: the
    // owner watches it complete live, there is no separate "read the result" action
    // to wait for. Without this, every one of those 134 owner tasks (from "you") was
    // permanently unprunable the moment it completed, regardless of age -- the exact
    // unbounded growth this function exists to prevent. An agent-initiated task still
    // requires the real read, since its sender may genuinely come back for the answer later.
    const seen = Boolean(t.resultShownAt) || t.from === "you";
    return (hasResult && seen) || (!hasResult && terminalWithoutResult);
  };
  const prunable = (t: Task): boolean => resolved(t) && input.now - Date.parse(t.createdAt) > input.maxAgeMs;
  const kept = tasks.filter((t) => !prunable(t));
  if (kept.length <= input.maxCount) return kept;
  // Still over budget even after dropping everything old enough: drop the oldest resolved ones first, oldest first,
  // until back within budget. Unresolved tasks are never dropped no matter how far over budget the list runs.
  const unresolved = kept.filter((t) => !resolved(t));
  const resolvedKept = kept.filter((t) => resolved(t)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const budgetForResolved = Math.max(0, input.maxCount - unresolved.length);
  const trimmedResolved = resolvedKept.slice(Math.max(0, resolvedKept.length - budgetForResolved));
  return [...unresolved, ...trimmedResolved].sort((a, b) => a.seq - b.seq || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
