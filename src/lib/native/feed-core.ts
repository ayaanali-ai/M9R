/**
 * The overlay feed (design: M9R_OVERLAY_DESIGN.md sections 4 and 5). Pure functions that turn the local store's snapshot
 * plus a few probe results into the one JSON document the overlay renders. Everything the overlay shows is decided here,
 * in tested TypeScript; the overlay itself only draws it.
 *
 * Every string that leaves this module has passed `redactSecrets` and a length cap, and the overlay draws text as plain
 * text, so nothing here can carry a secret or markup to the screen.
 */
import { isProtectedAction } from "./approval-core";
import { redactSecrets, type Task } from "./inbox-core";
import type { EndpointRecord, EventRecord, SessionRecord } from "./local-store";

export type AgentState = "open_working" | "open_idle" | "offline" | "unknown" | "seen" | "not_connected";

export interface FeedAgent {
  handle: string;
  state: AgentState;
  since?: string;
  doing: string | null;
  sessions: Array<{ id: string; cwd?: string; live: boolean | null }>;
  /** One plain sentence saying why the state is what it is, so the overlay never claims more than the evidence. */
  evidence: string;
}

export type NeedsYou =
  | { kind: "approval"; taskId: string; from: string; to: string; goal: string; protected: boolean }
  | { kind: "push_failed"; taskId: string; from: string; fromSession?: string; to: string; reason: string; fix: string; linkable: boolean }
  | { kind: "answer"; taskId: string; from: string; summary: string };

export interface FeedPing { id: number; kind: NeedsYou["kind"]; taskId: string; text: string }

/** A task that is under way and needs nothing from the person: the pill shows it so a pause reads as progress. */
export interface InProgress {
  taskId: string;
  from: string;
  to: string;
  goal: string;
  /** `queued`: pushed into the agent's session, waiting for it to pick up; `waiting_prompt`: the agent sees it at its next prompt; `working`: the agent has it. */
  state: "queued" | "waiting_prompt" | "working";
  since: string;
}

export interface Feed {
  version: 1;
  seq: number;
  generatedAt: string;
  agents: FeedAgent[];
  needsYou: NeedsYou[];
  inProgress: InProgress[];
  recent: Array<{ at: string; taskId?: string; text: string }>;
  pings: FeedPing[];
  reserved: { people: unknown[]; channels: unknown[] };
}

/** What a probe learned about one Codex session. `null` means the probe could not run. */
export interface SessionProbe {
  live: "live" | "free" | "unknown";
  /** From the tail of its rollout file: is a turn in progress? */
  turn: "working" | "idle" | "unknown";
}

export interface FeedInput {
  now: Date;
  endpoints: readonly EndpointRecord[];
  sessions: readonly SessionRecord[];
  tasks: readonly Task[];
  events: readonly EventRecord[];
  /** Keyed by session id; only Codex sessions are probed today. */
  probes: Readonly<Record<string, SessionProbe>>;
  /** Tasks whose approval has lapsed are not shown as waiting. */
  pendingIds: ReadonlySet<string>;
}

const GOAL_CHARS = 300;
const SUMMARY_CHARS = 400;
const REASON_CHARS = 200;
const RECENT_ITEMS = 10;
const SEEN_WINDOW_MS = 10 * 60_000;
const ANSWER_WINDOW_MS = 6 * 3_600_000;
/** Once the answer has reached the agent that asked, the pill only keeps it a little while. */
const SHOWN_ANSWER_WINDOW_MS = 10 * 60_000;
const FAILED_WINDOW_MS = 24 * 3_600_000;
const KNOWN_AGENTS = ["claude", "codex", "opencode"] as const;

const safe = (text: string, max: number) => {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Reads the tail of a Codex rollout file (JSON lines) and says whether a turn is in progress: the last
 * `task_started` or `task_complete` decides. Only the tail is needed; the file can be tens of megabytes.
 */
export function lastTurnState(tailText: string): "working" | "idle" | "unknown" {
  let state: "working" | "idle" | "unknown" = "unknown";
  for (const line of tailText.split(/\r?\n/)) {
    const started = line.includes('"task_started"');
    const complete = line.includes('"task_complete"');
    if (!started && !complete) continue;
    try {
      const type = (JSON.parse(line) as { payload?: { type?: string } }).payload?.type;
      if (type === "task_started") state = "working";
      else if (type === "task_complete") state = "idle";
    } catch { /* a cut-off first line of the tail */ }
  }
  return state;
}

function agentFor(handle: string, input: FeedInput): FeedAgent {
  const sessions = input.sessions.filter((s) => s.handle === handle).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const endpoint = input.endpoints.find((e) => e.handle === handle);
  const rows = sessions.slice().sort((a, b) => Number(input.probes[b.sessionId]?.turn === "working") - Number(input.probes[a.sessionId]?.turn === "working") || Number(input.probes[b.sessionId]?.live === "live") - Number(input.probes[a.sessionId]?.live === "live")).map((s) => ({ id: s.sessionId, cwd: s.cwd, live: (input.probes[s.sessionId]?.live === "live" ? true : input.probes[s.sessionId]?.live === "free" ? false : null) as boolean | null }));
  if (!endpoint && sessions.length === 0) return { handle, state: "not_connected", doing: null, sessions: [], evidence: "No session of this agent has been seen on this machine." };

  const probed = sessions.filter((s) => input.probes[s.sessionId]);
  if (probed.length > 0) {
    const open = probed.filter((s) => input.probes[s.sessionId].live === "live");
    if (open.length > 0) {
      const working = open.some((s) => input.probes[s.sessionId].turn === "working");
      const known = open.every((s) => input.probes[s.sessionId].turn !== "unknown");
      return {
        handle, sessions: rows, doing: null,
        state: working ? "open_working" : "open_idle",
        since: open[0].lastSeenAt,
        evidence: `${open.length} open session(s): its session file is held open${known ? `, ${working ? "a turn is in progress" : "no turn is running"}` : ""}.`,
      };
    }
    if (probed.every((s) => input.probes[s.sessionId].live === "free")) return { handle, state: "offline", sessions: rows, doing: null, evidence: "No session of this agent is open right now." };
    return { handle, state: "unknown", sessions: rows, doing: null, evidence: "Could not tell whether a session is open (the check does not run on this system)." };
  }

  // No open/closed signal for this agent (Claude Code today): say only what was seen and when.
  const lastSeen = endpoint?.lastSeenAt ?? sessions[0]?.lastSeenAt;
  const recentlySeen = lastSeen ? input.now.getTime() - Date.parse(lastSeen) < SEEN_WINDOW_MS : false;
  return {
    handle, sessions: rows, doing: null, since: lastSeen,
    state: recentlySeen ? "seen" : "unknown",
    evidence: lastSeen ? "Seen recently. M9R has no reliable open/closed signal for this agent yet." : "Seen before, but not recently.",
  };
}

const PROGRESS_WINDOW_MS = 60 * 60_000;

function inProgressFrom(input: FeedInput): InProgress[] {
  const nowMs = input.now.getTime();
  const out: InProgress[] = [];
  for (const t of input.tasks) {
    if (t.dismissedAt || t.resultSummary || t.approval === "pending" || t.approval === "denied" || t.approval === "expired") continue;
    if (nowMs - Date.parse(t.createdAt) > PROGRESS_WINDOW_MS) continue;
    const goal = safe(t.goal, 120);
    if (t.delivery?.state === "queued") out.push({ taskId: t.id, from: t.from, to: t.to, goal, state: "queued", since: t.delivery.queuedAt ?? t.createdAt });
    else if (t.delivery?.state === "failed") continue; // shown as a failed push instead
    else if (t.deliveredAt) out.push({ taskId: t.id, from: t.from, to: t.to, goal, state: "working", since: t.deliveredAt });
    else out.push({ taskId: t.id, from: t.from, to: t.to, goal, state: "waiting_prompt", since: t.createdAt });
  }
  return out.sort((a, b) => Number(b.taskId.slice(1)) - Number(a.taskId.slice(1))).slice(0, 4);
}

const needsKey = (n: NeedsYou) => `${n.kind}:${n.taskId}`;

function needsYouFrom(input: FeedInput): NeedsYou[] {
  const out: NeedsYou[] = [];
  const nowMs = input.now.getTime();
  for (const t of input.tasks) {
    if (t.dismissedAt) continue;
    if (t.approval === "pending" && input.pendingIds.has(t.id)) {
      out.push({ kind: "approval", taskId: t.id, from: t.from, to: t.to, goal: safe(t.goal, GOAL_CHARS), protected: isProtectedAction(t.goal) });
    } else if (t.delivery?.state === "failed" && t.approval !== "denied" && t.approval !== "expired" && nowMs - Date.parse(t.createdAt) < FAILED_WINDOW_MS && !t.deliveredAt) {
      const reason = t.delivery.error ?? "The push failed.";
      out.push({ kind: "push_failed", taskId: t.id, from: t.from, fromSession: t.fromSession, to: t.to, reason: safe(reason, REASON_CHARS), fix: /To aim it/.test(reason) ? "" : /sessions are open/.test(reason) ? "m9r-cli sessions, then m9r-cli send @codex --session <id> \"...\"" : "m9r-cli tasks", linkable: !!t.fromSession });
    } else if (t.resultSummary && nowMs - Date.parse(t.createdAt) < ANSWER_WINDOW_MS && (!t.resultShownAt || nowMs - Date.parse(t.resultShownAt) < SHOWN_ANSWER_WINDOW_MS)) {
      out.push({ kind: "answer", taskId: t.id, from: t.to, summary: safe(t.resultSummary, SUMMARY_CHARS) });
    }
  }
  // Approvals first (they block work), then failures, then answers; newest first within each.
  const rank = { approval: 0, push_failed: 1, answer: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || Number(b.taskId.slice(1)) - Number(a.taskId.slice(1)));
}

/** Builds the feed. `previous` (the last feed written) supplies `seq` and decides which items are new pings. */
export function buildFeed(input: FeedInput, previous: Feed | null): Feed {
  const handles = [...new Set<string>([...KNOWN_AGENTS, ...input.endpoints.map((e) => e.handle), ...input.sessions.map((s) => s.handle)])];
  const agents = handles.map((h) => agentFor(h, input));
  const needsYou = needsYouFrom(input);
  const inProgress = inProgressFrom(input);
  const recent = input.events.slice(-RECENT_ITEMS).reverse().map((e) => ({ at: e.at, taskId: e.taskId, text: safe(e.text, 140) }));

  const body = { agents, needsYou, inProgress, recent };
  const changed = !previous || JSON.stringify({ agents: previous.agents, needsYou: previous.needsYou, inProgress: previous.inProgress ?? [], recent: previous.recent }) !== JSON.stringify(body);
  const seq = previous ? (changed ? previous.seq + 1 : previous.seq) : 1;

  const before = new Set((previous?.needsYou ?? []).map(needsKey));
  const pings: FeedPing[] = changed
    ? needsYou.filter((n) => !before.has(needsKey(n))).map((n) => ({
        id: seq, kind: n.kind, taskId: n.taskId,
        text: n.kind === "approval" ? `@${n.from} asks @${n.to}: ${n.goal}` : n.kind === "push_failed" ? `${n.taskId} could not be pushed: ${n.reason}` : `@${n.from} answered ${n.taskId}`,
      }))
    : (previous?.pings ?? []);
  return { version: 1, seq, generatedAt: input.now.toISOString(), agents, needsYou, inProgress, recent, pings, reserved: { people: [], channels: [] } };
}

/** The part of a feed that matters for "did anything change" (everything but the timestamp). */
export const feedBody = (f: Feed) => JSON.stringify({ ...f, generatedAt: undefined });
