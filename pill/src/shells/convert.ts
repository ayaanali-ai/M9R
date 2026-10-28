// Pure converters from what each host already produces into the pill's one snapshot shape. No DOM, no host APIs.

import type { AgentRunState, PillModelAgent, PillModelOption, PillModelState, PillSnapshot, Provider } from "../core/state";
import { collaborationFromAgents, sanitizePillCollaboration } from "../core/presence";

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
interface UiModelEffort { id?: unknown; label?: unknown }
interface UiModelOption { id?: unknown; label?: unknown; efforts?: unknown }
interface UiModelAgent { handle?: unknown; provider?: unknown; availability?: unknown; models?: unknown; currentModel?: unknown; currentEffort?: unknown; status?: unknown }
export interface UiState { agents?: UiAgent[]; thread?: UiThread[]; approvals?: UiApproval[]; collaboration?: unknown; models?: unknown; desktopPill?: boolean }

const RUN_STATES = new Set<AgentRunState>(["idle", "starting", "working", "waiting", "blocked", "stopped", "failed", "seen", "unknown", "not_connected"]);

function modelState(raw: unknown): PillModelState | undefined {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { agents?: unknown }).agents)) return undefined;
  const agents: PillModelAgent[] = [];
  for (const value of (raw as { agents: unknown[] }).agents.slice(0, 16)) {
    if (!value || typeof value !== "object") continue;
    const item = value as UiModelAgent;
    const handle = typeof item.handle === "string" ? item.handle.replace(/^@/, "").trim().slice(0, 40) : "";
    const availability = item.availability === "available" || item.availability === "not_connected" || item.availability === "catalog_unavailable" ? item.availability : "catalog_unavailable";
    if (!handle) continue;
    const models: PillModelOption[] = [];
    if (Array.isArray(item.models)) for (const optionValue of item.models.slice(0, 64)) {
      if (!optionValue || typeof optionValue !== "object") continue;
      const option = optionValue as UiModelOption;
      if (typeof option.id !== "string" || typeof option.label !== "string" || !option.id.trim() || !option.label.trim()) continue;
      const efforts = Array.isArray(option.efforts) ? option.efforts.flatMap((effortValue): { id: string; label: string }[] => {
        if (!effortValue || typeof effortValue !== "object") return [];
        const effort = effortValue as UiModelEffort;
        return typeof effort.id === "string" && typeof effort.label === "string" && effort.id.trim() && effort.label.trim() ? [{ id: effort.id.slice(0, 160), label: effort.label.slice(0, 240) }] : [];
      }).slice(0, 32) : null;
      models.push({ id: option.id.slice(0, 160), label: option.label.slice(0, 240), efforts });
    }
    agents.push({
      handle,
      provider: typeof item.provider === "string" ? item.provider.slice(0, 64) : "agent",
      availability,
      models,
      currentModel: typeof item.currentModel === "string" ? item.currentModel.slice(0, 160) : null,
      currentEffort: typeof item.currentEffort === "string" ? item.currentEffort.slice(0, 160) : null,
      status: typeof item.status === "string" ? item.status.slice(0, 24) : "stopped",
    });
  }
  return { agents };
}

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
      state: (RUN_STATES.has(a.state as AgentRunState) ? a.state : "unknown") as AgentRunState,
      activity,
      ...(doing ? { task: doing } : {}),
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
  const collaboration = sanitizePillCollaboration(message.collaboration) ?? collaborationFromAgents(agents);
  const models = modelState(message.models);
  return { agents, collaboration, approvals, thread: replies, ...(models ? { models } : {}), ...(message.desktopPill === true ? { desktopPill: true } : {}) };
}

// ── Desktop shell: the engine's feed.json merged with web-activity.json ────────────────────────────

interface FeedAgent { handle: string; state?: string; doing?: string | null }
type FeedNeeds =
  | { kind: "approval"; taskId: string; from: string; to: string; goal: string; protected?: boolean }
  | { kind: "push_failed"; taskId: string; from: string; fromSession?: string; to: string; reason: string; fix?: string; linkable?: boolean }
  | { kind: "delivery_uncertain"; taskId: string; from: string; to: string; reason: string }
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
  seen: "seen",
  unknown: "unknown",
  offline: "stopped",
  not_connected: "not_connected",
};

export function fromFeed(feed: Feed): PillSnapshot {
  const web = Array.isArray(feed.web) ? feed.web : [];
  const progress = Array.isArray(feed.inProgress) ? feed.inProgress : [];
  const agents = (Array.isArray(feed.agents) ? feed.agents : []).map((a) => {
    const handle = String(a.handle).replace(/^@/, "");
    const assigned = progress.filter((p) => p.to === handle);
    // Provider probes own the live state. A task being sent, queued, or waiting for a prompt
    // is never promoted to a running turn.
    const mine = assigned.map((p) => clip(`@${p.from} asked: ${p.goal}`, 140));
    // Web events arrive newest first; show them oldest first like the other shell does.
    const acted = web.filter((w) => w.agent === handle && (w.kind === "action" || w.kind === "message")).slice(0, 8).reverse().map((w) => clip(w.text, 140));
    const state: AgentRunState = FEED_STATES[String(a.state)] ?? "unknown";
    // What the agent is doing right now, read from its own transcript. Last, so it is the line the ticker highlights.
    const doing = typeof (a as FeedAgent).doing === "string" ? clip((a as FeedAgent).doing as string, 140) : "";
    const task = doing || "";
    const steps = [...acted, ...mine];
    if (doing && steps.at(-1) !== doing) steps.push(doing);
    else if (state === "working" && steps.length === 0) steps.push("Working on a turn");
    return { handle, provider: providerOf(handle), state, activity: steps.slice(-12), ...(task ? { task } : {}) };
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
        : n.kind === "delivery_uncertain"
          ? [{ id: `uncertain-${n.taskId}`, from: "m9r", text: clip(`Could not confirm delivery of ${n.taskId} to @${n.to}; it will not be resent automatically. ${n.reason}`, 300) }]
        : []),
  ];
  return { agents, collaboration: collaborationFromAgents(agents), approvals, thread };
}
