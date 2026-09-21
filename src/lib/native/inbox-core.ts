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
  resultSummary?: string;
  /** Set when the sender was first shown the result (once). */
  resultShownAt?: string;
  /** Set when the user cleared it from the overlay's "needs you" list. Hides it there; changes nothing about delivery. */
  dismissedAt?: string;
  /** Native push (N2): how far pushing this task into the target session got. Absent for plain inbox tasks. */
  delivery?: TaskDelivery;
  /** Working directory of the sender; used to pick the target's session when several are open. */
  cwd?: string;
  /** Session id (or unique prefix) the sender pinned, so a push never has to guess. */
  targetSession?: string;
}

export interface TaskDelivery {
  /** `queued` = pushed into the target session; `done` = the answer came back; `failed` = fell back to the inbox. */
  state: "queued" | "failed" | "done";
  attempts: number;
  threadId?: string;
  queuedAt?: string;
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
    from: input.from,
    to: input.to,
    goal: goal.text,
    goalTruncated: goal.truncated,
    pointers,
    origin: input.origin,
    approval: initialApproval(input),
    replyDepth: input.replyDepth ?? 0,
    idempotencyKey: input.idempotencyKey,
    createdAt: nowIso,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.targetSession ? { targetSession: input.targetSession } : {}),
  };
}

const RESULT_ITEMS = 3;
const RESULT_CHARS = 400;

/** Answers to tasks this agent sent, shown once at its next prompt. Empty when there are none (zero tokens). */
export function renderResultsInjection(tasks: readonly Task[], handle: string): { text: string; ids: string[] } {
  const ready = tasks.filter((t) => t.from === handle && t.resultSummary && !t.resultShownAt).slice(0, RESULT_ITEMS);
  if (ready.length === 0) return { text: "", ids: [] };
  const lines = ready.map((t) => `[${t.id} finished by @${t.to}] ${clip(t.resultSummary ?? "", RESULT_CHARS).text}`);
  return { text: `M9R results (${ready.length})\n${lines.join("\n")}`, ids: ready.map((t) => t.id) };
}

/** Same key means the same task: a repeated send must not create or deliver a second one. */
export function findByIdempotencyKey(tasks: readonly Task[], to: string, key: string): Task | undefined {
  return tasks.find((t) => t.to === to && t.idempotencyKey === key);
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
export function renderInboxInjection(tasks: readonly Task[], cursor: number): InjectionResult {
  const visible = tasks
    // A task already pushed into the session as a real prompt must not be injected a second time from the inbox.
    .filter((t) => t.seq > cursor && t.approval !== "denied" && t.approval !== "expired" && t.delivery?.state !== "queued" && t.delivery?.state !== "done")
    .sort((a, b) => a.seq - b.seq);
  const shown = visible.slice(0, CAPS.inboxItems);
  if (shown.length === 0) return { text: "", includedIds: [], newCursor: cursor, omitted: 0 };
  const perItemChars = CAPS.inboxItemTokens * 4;
  const lines = shown.map((t) => {
    const head = `[${t.id} from @${t.from}, ${approvalLabel(t)}] `;
    const tail = ` Details: get_task ${t.id}.`;
    const room = Math.max(40, Math.min(ENVELOPE_GOAL_CHARS, perItemChars - head.length - tail.length));
    // The pointer is only useful (and only safe to mention) when the text shown is not the whole goal.
    const shown = clip(t.goal, room);
    return head + shown.text + (shown.truncated || t.goalTruncated ? tail : "");
  });
  const omitted = visible.length - shown.length;
  const more = omitted > 0 ? ` (${omitted} more waiting: call inbox.)` : "";
  return {
    text: `M9R inbox (${shown.length} new)${more}\n${lines.join("\n")}`,
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
}

/** The once-per-session card: a handful of lines, pointers only, never memory content. */
export function renderSessionCard(input: CardInput): string {
  const others = input.others.slice(0, CAPS.cardOthers).map((o) => `@${o.handle}${o.activity ? ` (${o.activity.slice(0, 60)})` : ""}`);
  const lines = [
    `M9R connected as @${input.handle}.`,
    others.length ? `Active now: ${others.join(", ")}.` : "No other agents active.",
    input.pendingCount > 0 ? `${input.pendingCount} pending inbox item(s); they appear at your next prompt.` : "",
    input.awaitingApproval ? `${input.awaitingApproval} task(s) are waiting for the user's approval; if it comes up, tell the user to run: m9r-cli tasks.` : "",
    input.memoryDir ? `Earlier agent sessions on this project are indexed in ${input.memoryDir}/index.md; read a short summary there before re-deriving earlier work.` : "",
  ].filter(Boolean);
  const card = lines.join(" ");
  return approxTokens(card) <= CAPS.cardTokens ? card : clip(card, CAPS.cardTokens * 4).text;
}

/** The one line injected after a human-typed mention so the sending agent does not do the work itself. */
export function renderSentAck(taskId: string, to: string): string {
  return `M9R already sent your message to @${to} as task ${taskId}, so @${to} will do it. Do not do that work yourself: tell the user it was sent to @${to}, and continue with anything else. The result will arrive in your inbox.`;
}
