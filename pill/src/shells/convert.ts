// Pure converters from what each host already produces into the pill's one snapshot shape. No DOM, no host APIs.

import type { AgentRunState, PillSnapshot, Provider } from "../core/state";

export function providerOf(value: unknown): Provider {
  const v = String(value ?? "").toLowerCase();
  if (/claude|anthropic/.test(v)) return "claude";
  if (/codex|openai/.test(v)) return "codex";
  if (/opencode/.test(v)) return "opencode";
  return "agent";
}

const clip = (text: unknown, n: number) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, n) : "");

// ── Browser shell: the broker's `ui-state` as the extension delivers it ──────────────────────────────

interface UiAgent { id: string; provider?: string; state?: string; doing?: string }
interface UiThread { id: string; kind: string; agent?: string; text: string; phase?: string }
interface UiApproval { id: string; agent?: string; provider?: string; text: string; site?: string; url?: string; action?: string }
export interface UiState { agents?: UiAgent[]; thread?: UiThread[]; approvals?: UiApproval[]; desktopPill?: boolean }

const RUN_STATES = new Set<AgentRunState>(["idle", "starting", "working", "waiting", "blocked", "stopped", "failed"]);

export function fromUiState(message: UiState): PillSnapshot {
  const thread = Array.isArray(message.thread) ? message.thread : [];
  const agents = (Array.isArray(message.agents) ? message.agents : []).map((a) => {
    const handle = String(a.id).replace(/^@/, "");
    // The agent's own recent actions and words, oldest first, ending with what it is doing now.
    const activity = thread
      .filter((t) => (t.kind === "do" || t.kind === "say") && String(t.agent ?? "").replace(/^@/, "") === handle && !(t.phase === "start"))
      .map((t) => clip(t.text, 140))
      .filter(Boolean)
      .slice(-12);
    const doing = clip(a.doing, 140);
    if (doing && activity.at(-1) !== doing) activity.push(doing);
    return {
      handle,
      provider: providerOf(a.provider || handle),
      state: (RUN_STATES.has(a.state as AgentRunState) ? a.state : "idle") as AgentRunState,
      activity,
    };
  });
  const approvals = (Array.isArray(message.approvals) ? message.approvals : []).map((p) => ({
    id: String(p.id),
    agent: String(p.agent ?? "").replace(/^@/, ""),
    title: clip(p.action, 80) || "act on this page",
    detail: clip(p.text, 300) + (p.site ? `  ·  ${clip(p.site, 80)}` : ""),
  }));
  const replies = thread
    .filter((t) => t.kind === "say" || t.kind === "system" || t.kind === "block")
    .slice(-30)
    .map((t) => ({ id: String(t.id), from: String(t.agent ?? "").replace(/^@/, "") || "m9r", text: clip(t.text, 600) }));
  return { agents, approvals, thread: replies, ...(message.desktopPill === true ? { desktopPill: true } : {}) };
}

// ── Desktop shell: the engine's feed.json merged with web-activity.json ────────────────────────────

interface FeedAgent { handle: string; state?: string; doing?: string | null }
type FeedNeeds =
  | { kind: "approval"; taskId: string; from: string; to: string; goal: string; protected?: boolean }
  | { kind: "push_failed"; taskId: string; from: string; fromSession?: string; to: string; reason: string; fix?: string; linkable?: boolean }
  | { kind: "answer"; taskId: string; from: string; summary: string };
interface FeedInProgress { taskId: string; from: string; to: string; goal: string; state?: string }
interface FeedWeb { at: string; agent: string; kind: string; text: string }
export interface Feed {
  agents?: FeedAgent[];
  needsYou?: FeedNeeds[];
  inProgress?: FeedInProgress[];
  recent?: Array<{ at: string; taskId?: string; text: string }>;
  web?: FeedWeb[];
}

const FEED_STATES: Record<string, AgentRunState> = {
  open_working: "working",
  open_idle: "idle",
  seen: "idle",
  unknown: "idle",
  offline: "stopped",
  not_connected: "stopped",
};

export function fromFeed(feed: Feed): PillSnapshot {
  const web = Array.isArray(feed.web) ? feed.web : [];
  const progress = Array.isArray(feed.inProgress) ? feed.inProgress : [];
  const agents = (Array.isArray(feed.agents) ? feed.agents : []).map((a) => {
    const handle = String(a.handle).replace(/^@/, "");
    const mine = progress.filter((p) => p.to === handle).map((p) => clip(`@${p.from} asked: ${p.goal}`, 140));
    // Web events arrive newest first; show them oldest first like the other shell does.
    const acted = web.filter((w) => w.agent === handle && (w.kind === "action" || w.kind === "message")).slice(0, 8).reverse().map((w) => clip(w.text, 140));
    let state: AgentRunState = FEED_STATES[String(a.state)] ?? "idle";
    if (state === "idle" && progress.some((p) => p.to === handle && p.state === "working")) state = "working";
    // What the agent is doing right now, read from its own transcript. Last, so it is the line the ticker highlights.
    const doing = typeof (a as FeedAgent).doing === "string" ? clip((a as FeedAgent).doing as string, 140) : "";
    const steps = [...acted, ...mine];
    if (doing && steps.at(-1) !== doing) steps.push(doing);
    if (state === "working" && steps.length === 0) steps.push("Working on a turn");
    return { handle, provider: providerOf(handle), state, activity: steps.slice(-12) };
  });
  const needs = Array.isArray(feed.needsYou) ? feed.needsYou : [];
  const approvals = needs.flatMap((n) => n.kind === "approval"
    ? [{ id: n.taskId, agent: n.to, title: `@${n.from} asks @${n.to}`, detail: clip(n.goal, 300) }]
    : []);
  const thread = [
    ...needs.flatMap((n) => n.kind === "answer"
      ? [{ id: `answer-${n.taskId}`, from: n.from, text: clip(n.summary, 600) }]
      : n.kind === "push_failed"
        ? [{
          id: `failed-${n.taskId}`, from: n.to, text: clip(`Could not deliver ${n.taskId}: ${n.reason}`, 300),
          ...(n.linkable === true ? { link: { taskId: n.taskId, from: n.from, ...(n.fromSession ? { fromSession: n.fromSession } : {}), to: n.to } } : {}),
        }]
        : []),
  ];
  return { agents, approvals, thread };
}
