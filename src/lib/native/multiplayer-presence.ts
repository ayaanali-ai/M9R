import {
  MAX_ACTIVE_AGENTS,
  parsePresenceEvent,
  type MultiplayerAgent,
  type MultiplayerRoster,
  type PresenceEvent,
  type PresenceState,
  validateMultiplayerRoster,
} from "./multiplayer-contract";

/**
 * Phase 8 presence model.
 *
 * Presence is deliberately a small, structured view of coordination. It is
 * not a transcript and it never carries provider session ids, credentials,
 * prompts, or desktop coordinates. A consumer can therefore render it in the
 * pill without turning the pill into a raw-log viewer.
 */

export const PRESENCE_PALETTE = [
  "#7AA2F7", "#D97757", "#34D399", "#C084FC", "#F59E0B", "#22D3EE", "#FB7185", "#A3E635",
  "#F472B6", "#38BDF8", "#FACC15", "#4ADE80", "#818CF8", "#FB923C", "#2DD4BF", "#E879F9",
] as const;

export type PresenceCursorMode = PresenceState;

export interface PresenceAgent {
  agentId: string;
  branchId: string;
  provider: string;
  label: string;
  color: string;
  state: PresenceState;
  cursor: { mode: PresenceCursorMode; visible: boolean };
  revision: number;
  updatedAt: number;
  summary?: string;
  surfaceId?: string;
  regionId?: string;
}
export interface PresenceSnapshot {
  agents: PresenceAgent[];
  /** IDs selected for the compact, always-visible pill row. */
  featuredAgentIds: string[];
  activeCount: number;
  overflowCount: number;
  headline: string;
}

export interface PresenceAgentRecord {
  agentId: string;
  branchId?: string;
  provider: string;
  handle?: string;
  state: PresenceState;
  summary?: string;
  revision?: number;
  updatedAt?: number;
  surfaceId?: string;
  regionId?: string;
}

export type PresenceApplyResult =
  | { accepted: true; event: PresenceEvent }
  | { accepted: false; reason: "invalid" | "wrong-run" | "unknown-agent" | "stale" | "wrong-branch" };

const TERMINAL_STATES = new Set<PresenceState>(["completed", "stopped"]);
const STATE_WORD: Record<PresenceState, string> = {
  thinking: "thinking",
  asking: "asking for help",
  preparing: "preparing",
  observing: "observing",
  acting: "acting",
  waiting: "waiting",
  blocked: "blocked",
  completed: "completed",
  stopped: "stopped",
};

function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function identifier(value: string, fallback: string): string {
  const safe = safeText(value, 128).replace(/[^A-Za-z0-9._:%-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe || fallback;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** A color is a function of the stable agent identity, never roster order. */
export function presenceColor(agentId: string): string {
  return PRESENCE_PALETTE[hash(agentId) % PRESENCE_PALETTE.length];
}

/** The pill label is bounded and based only on the configured provider/handle. */
export function presenceLabel(agent: Pick<PresenceAgentRecord, "agentId" | "provider" | "handle">): string {
  const handle = safeText(agent.handle, 64).replace(/^@/, "");
  const provider = safeText(agent.provider, 48);
  return `@${handle || provider || safeText(agent.agentId, 64)}`.slice(0, 80);
}

function isActive(state: PresenceState): boolean {
  return !TERMINAL_STATES.has(state);
}

function orderAgents(a: PresenceAgent, b: PresenceAgent): number {
  const aActive = isActive(a.state) ? 0 : 1;
  const bActive = isActive(b.state) ? 0 : 1;
  return aActive - bActive || b.updatedAt - a.updatedAt || a.label.localeCompare(b.label) || a.agentId.localeCompare(b.agentId);
}

function headline(agents: readonly PresenceAgent[], activeCount: number, overflowCount: number): string {
  if (agents.length === 0) return "No agents connected";
  const featured = agents.slice(0, 3).map((agent) => `${agent.label} ${STATE_WORD[agent.state]}`);
  const suffix = overflowCount > 0 ? ` · +${overflowCount} more` : "";
  return `${featured.join(" · ")}${suffix}${activeCount === 0 ? " · all finished" : ""}`;
}

function snapshotOf(records: readonly PresenceAgentRecord[]): PresenceSnapshot {
  const deduped = new Map<string, PresenceAgent>();
  for (const record of records.slice(0, MAX_ACTIVE_AGENTS)) {
    const agentId = identifier(record.agentId, "agent");
    const branchId = identifier(record.branchId ?? `${agentId}-branch`, `${agentId}-branch`);
    const state = record.state;
    const item: PresenceAgent = {
      agentId,
      branchId,
      provider: safeText(record.provider, 48) || "agent",
      label: presenceLabel({ ...record, agentId }),
      color: presenceColor(agentId),
      state,
      cursor: { mode: state, visible: isActive(state) },
      revision: Number.isSafeInteger(record.revision) && (record.revision ?? 0) >= 0 ? record.revision! : 0,
      updatedAt: Number.isSafeInteger(record.updatedAt) && (record.updatedAt ?? 0) >= 0 ? record.updatedAt! : 0,
      ...(safeText(record.summary, 160) ? { summary: safeText(record.summary, 160) } : {}),
      ...(safeText(record.surfaceId, 128) ? { surfaceId: identifier(record.surfaceId!, "surface") } : {}),
      ...(safeText(record.regionId, 128) ? { regionId: identifier(record.regionId!, "region") } : {}),
    };
    deduped.set(agentId, item);
  }
  const agents = [...deduped.values()].sort(orderAgents).slice(0, MAX_ACTIVE_AGENTS);
  const activeCount = agents.filter((agent) => isActive(agent.state)).length;
  const featuredAgentIds = agents.slice(0, 3).map((agent) => agent.agentId);
  const overflowCount = Math.max(0, agents.length - featuredAgentIds.length);
  return { agents, featuredAgentIds, activeCount, overflowCount, headline: headline(agents, activeCount, overflowCount) };
}

/** Build a UI snapshot from session status without requiring a live event stream. */
export function snapshotFromRecords(records: readonly PresenceAgentRecord[]): PresenceSnapshot {
  return snapshotOf(records);
}

export function presenceStateForUi(state: string, waitingOn?: string): PresenceState {
  if (waitingOn) return "waiting";
  switch (state) {
    case "starting": return "preparing";
    case "working": return "acting";
    case "waiting": return "waiting";
    case "blocked":
    case "failed": return "blocked";
    case "stopped": return "stopped";
    case "idle": return "completed";
    default: return "thinking";
  }
}

/**
 * An event reducer with run/branch fencing and monotonic revisions. It is
 * intentionally in-memory; persistence belongs to the runtime owner, not the
 * pill. Out-of-order provider updates are ignored instead of flashing stale UI.
 */
export function createPresenceStore(rosterInput: MultiplayerRoster | unknown, options: { now?: () => number } = {}) {
  const checked = validateMultiplayerRoster(rosterInput);
  if (!checked.ok) throw new Error(`Invalid multiplayer presence roster: ${checked.error}`);
  const roster = checked.roster;
  const now = options.now ?? Date.now;
  const byAgent = new Map(roster.agents.map((agent) => [agent.agentId, agent] as const));
  const events = new Map<string, PresenceEvent>();

  const snapshot = (): PresenceSnapshot => snapshotOf(roster.agents.map((agent) => {
    const event = events.get(agent.agentId);
    return {
      agentId: agent.agentId,
      branchId: agent.branchId,
      provider: agent.provider,
      handle: agent.handle,
      state: event?.state ?? "thinking",
      summary: event?.summary,
      revision: event?.revision ?? 0,
      updatedAt: event?.occurredAt ?? 0,
      surfaceId: event?.surfaceId,
      regionId: event?.regionId,
    };
  }));

  const apply = (value: unknown): PresenceApplyResult => {
    const parsed = (() => {
      try { return parsePresenceEvent(value); } catch { return null; }
    })();
    if (!parsed) return { accepted: false, reason: "invalid" };
    if (parsed.runId !== roster.runId) return { accepted: false, reason: "wrong-run" };
    const agent = byAgent.get(parsed.agentId);
    if (!agent) return { accepted: false, reason: "unknown-agent" };
    if (agent.branchId !== parsed.branchId) return { accepted: false, reason: "wrong-branch" };
    const previous = events.get(parsed.agentId);
    if (previous && parsed.revision <= previous.revision) return { accepted: false, reason: "stale" };
    events.set(parsed.agentId, parsed);
    return { accepted: true, event: parsed };
  };

  return {
    roster,
    apply,
    snapshot,
    /** Remove an event while retaining the roster identity (used on run stop). */
    clear(agentId?: string) {
      if (agentId) events.delete(agentId); else events.clear();
    },
    now,
  };
}
