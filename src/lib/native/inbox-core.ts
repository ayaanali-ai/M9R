/**
 * Task, inbox and injection-format core for the native front door (design sections 6, 7, 9 and 12).
 * Pure functions only: no file, network or clock access, so the same code runs in a hook, the Node and a test.
 *
 * Token discipline is a hard rule here: everything injected into an agent's context is capped, delta-only, and a
 * pointer (`get_task <id>`), never a payload.
 */

/** The existing goal cap from the network spec. */
export const MAX_GOAL_CHARS = 2000;
export const MAX_RESULT_SUMMARY_CHARS = 400;
export const ENVELOPE_GOAL_CHARS = 600;
export const MAX_POINTERS = 12;
export const MAX_POINTER_CHARS = 200;
/** Proposed caps (design section 12); kept together so they can change without a release. */
export const CAPS = {
  cardTokens: 300,
  inboxItems: 3,
  inboxItemTokens: 200,
  cardOthers: 5,
} as const;

export const TRUNCATION_MARKER = " [truncated: full text via get_task]";

export type Approval = "not_needed" | "pending" | "approved" | "denied" | "expired";
export type Origin = "human_typed" | "agent_initiated";

/**
 * Provider-neutral evidence for one task. Transport state remains on
 * `TaskDelivery` for adapter-specific details; this is the single receipt
 * contract every delivery path updates.
 */
export type TaskReceiptState = "accepted" | "dispatched" | "provider_received" | "started"
  | "completed" | "canceled" | "failed" | "retryable" | "uncertain";
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
  accepted: ["dispatched", "provider_received", "started", "completed", "canceled", "failed", "retryable", "uncertain"],
  dispatched: ["provider_received", "started", "completed", "canceled", "failed", "retryable", "uncertain"],
  provider_received: ["started", "completed", "canceled", "failed", "uncertain"],
  started: ["completed", "canceled", "failed", "uncertain"],
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
    ...(event.error ? { error: event.error } : event.state === "completed" || event.state === "canceled" ? { error: undefined } : {}),
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

  if (transition.state === "completed" && receipt.state !== "completed" && receipt.state !== "canceled") {
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
  | "sdk-load" | "host-connect" | "runtime-acquire" | "session-start" | "cursor-motion" | "cursor-visible";

/**
 * Timing is deliberately kept on the task record so a later result or audit can reconcile
 * the complete turn without depending on process stderr or a live broker. It contains no
 * task text, credentials, window identifiers, or desktop pixels.
 */
export interface StageTimingEvent {
  phase: StageTimingPhase;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  operationId?: string;
  detail?: string;
}

/** Canonical inbox key: tolerate a single mention marker and provider-handle casing. */
export function normalizeHandle(handle: string): string {
  return (handle.startsWith("@") ? handle.slice(1) : handle).toLowerCase();
}

export interface Task {
  id: string;
  /** Monotonic per-inbox sequence; the cursor is the highest seq an agent has been shown. */
  seq: number;
  from: string;
  to: string;
  goal: string;
  goalTruncated: boolean;
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
  /** Native push (N2): how far pushing this task into the target session got. Absent for plain inbox tasks. */
  delivery?: TaskDelivery;
  /** Bounded transport transition evidence, independent of the final task result. */
  deliveryHistory?: TaskDelivery[];
  /** Durable target-session receipt; unlike a cursor this records what was actually presented. */
  lifecycle?: TaskLifecycle;
  /** Provider-neutral delivery receipt; old state files may not have this field and are backfilled on mutation. */
  receipt?: TaskReceipt;
  /** Working directory of the sender; used to pick the target's session when several are open. */
  cwd?: string;
  /** Session id (or unique prefix) the sender pinned, so a push never has to guess. */
  targetSession?: string;
  /** The sender's own session (a Codex thread id, say), so the answer can be pushed back to exactly that session. */
  fromSession?: string;
  /** Internal authorization lineage; never included in provider-facing task text. */
  parentTaskId?: string;
  /** The session the task was shown in (its inbox delivery), so its answer is read from that session's transcript. */
  deliveredSession?: string;
  /** Set when the answer was pushed back into the sender's session. */
  answerPushedAt?: string;
  /** Durable, bounded phase timings for native desktop-stage requests. */
  stageTiming?: StageTimingEvent[];
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

/** Whether a new task needs a human decision before the target acts on it (design section 7). */
export function initialApproval(input: Pick<NewTaskInput, "origin" | "standingRuleApplies">): Approval {
  if (input.origin === "human_typed") return "not_needed";
  return input.standingRuleApplies ? "approved" : "pending";
}

export function newTask(input: NewTaskInput, ids: { id: string; seq: number }, nowIso: string): Task {
  const goal = clip(redactSecrets(input.goal.trim()), MAX_GOAL_CHARS);
  if (!goal.text) throw new Error("A task needs a goal.");
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
    replyDepth: input.replyDepth ?? 0,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowIso,
    receipt: initialTaskReceipt(nowIso),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.targetSession ? { targetSession: input.targetSession } : {}),
    ...(input.fromSession ? { fromSession: input.fromSession } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
  };
}

const RESULT_ITEMS = 3;
const RESULT_CHARS = 400;

/** Answers to tasks this agent sent, shown once at its next prompt. Empty when there are none (zero tokens). */
export function renderResultsInjection(tasks: readonly Task[], handle: string, options: { includeTaskIds?: boolean } = {}): { text: string; ids: string[] } {
  const normalizedHandle = normalizeHandle(handle);
  const ready = tasks.filter((t) => normalizeHandle(t.from) === normalizedHandle && t.resultSummary && !t.resultShownAt).slice(0, RESULT_ITEMS);
  if (ready.length === 0) return { text: "", ids: [] };
  const includeTaskIds = options.includeTaskIds !== false;
  const lines = ready.map((t) => includeTaskIds
    ? `[${t.id} finished by @${t.to}] ${clip(t.resultSummary ?? "", RESULT_CHARS).text}`
    : `Work finished by @${t.to}: ${clip(t.resultSummary ?? "", RESULT_CHARS).text}`);
  return { text: `M9R results (${ready.length})\n${lines.join("\n")}`, ids: ready.map((t) => t.id) };
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
    .filter((t) => t.seq > cursor && t.approval !== "denied" && t.approval !== "expired"
      && t.receipt?.state !== "canceled"
      && !["sending", "queued", "uncertain", "done"].includes(t.delivery?.state ?? "")
      && !t.resultSummary && !(now - Date.parse(t.createdAt) > maxAge))
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
    const head = includeTaskIds ? `[${t.id} from ${sender}, ${approvalLabel(t)}] ` : `M9R work from ${sender}: `;
    const tail = includeTaskIds ? ` Details: get_task ${t.id}.` : " More detail is available through the connected M9R context.";
    const room = Math.max(40, Math.min(goalChars, perItemChars - head.length - tail.length));
    // The pointer is only useful (and only safe to mention) when the text shown is not the whole goal.
    const shown = clip(t.goal, room);
    return head + shown.text + (shown.truncated || t.goalTruncated ? tail : "");
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
export function pruneTasks(tasks: readonly Task[], input: { maxCount: number; maxAgeMs: number; now: number }): Task[] {
  const resolved = (t: Task): boolean => {
    if (!t.deliveredAt || t.approval === "pending") return false;
    const hasResult = t.resultSummary !== undefined;
    const terminalWithoutResult = t.approval === "denied" || t.approval === "expired";
    return (hasResult && Boolean(t.resultShownAt)) || (!hasResult && terminalWithoutResult);
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
