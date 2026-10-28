/** Wire-safe presence helpers for the shared pill bundle. No provider logs or window coordinates enter this shape. */

export const PILL_PRESENCE_COLORS = [
  "#7AA2F7", "#D97757", "#34D399", "#C084FC", "#F59E0B", "#22D3EE", "#FB7185", "#A3E635",
  "#F472B6", "#38BDF8", "#FACC15", "#4ADE80", "#818CF8", "#FB923C", "#2DD4BF", "#E879F9",
] as const;

export type PillPresenceState = "thinking" | "asking" | "preparing" | "observing" | "acting" | "waiting" | "blocked" | "completed" | "stopped";

export interface PillPresenceAgent {
  agentId: string;
  label: string;
  provider: string;
  color: string;
  state: PillPresenceState;
  cursor: { mode: PillPresenceState; visible: boolean };
  summary?: string;
  surfaceId?: string;
  regionId?: string;
}
export interface PillCollaboration {
  agents: PillPresenceAgent[];
  featuredAgentIds: string[];
  activeCount: number;
  overflowCount: number;
  headline: string;
}

const TERMINAL = new Set<PillPresenceState>(["completed", "stopped"]);
const WORD: Record<PillPresenceState, string> = {
  thinking: "thinking", asking: "asking for help", preparing: "preparing", observing: "observing", acting: "acting",
  waiting: "waiting", blocked: "blocked", completed: "completed", stopped: "stopped",
};

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return result >>> 0;
}

export function stablePresenceColor(agentId: string): string {
  return PILL_PRESENCE_COLORS[hash(agentId) % PILL_PRESENCE_COLORS.length];
}

export function presenceStateForRun(state: string, waitingOn = false): PillPresenceState {
  if (waitingOn) return "waiting";
  if (state === "starting") return "preparing";
  if (state === "working") return "acting";
  if (state === "waiting") return "waiting";
  if (state === "blocked" || state === "failed") return "blocked";
  if (state === "stopped" || state === "not_connected") return "stopped";
  if (state === "idle" || state === "seen") return "completed";
  return "thinking";
}

export function collaborationFromAgents(agents: ReadonlyArray<{ handle: string; provider: string; state: string; task?: string }>): PillCollaboration {
  const rows = agents.slice(0, 16).map((agent) => {
    const id = agent.handle.replace(/^@/, "").slice(0, 128);
    const state = presenceStateForRun(agent.state);
    return {
      agentId: id,
      label: `@${id}`.slice(0, 80),
      provider: agent.provider.slice(0, 48),
      color: stablePresenceColor(id),
      state,
      cursor: { mode: state, visible: !TERMINAL.has(state) },
      ...(agent.task ? { summary: agent.task.slice(0, 160) } : {}),
    } satisfies PillPresenceAgent;
  });
  const active = rows.filter((agent) => !TERMINAL.has(agent.state));
  const featured = rows.slice(0, 3);
  const overflowCount = Math.max(0, rows.length - featured.length);
  const headline = rows.length === 0
    ? "No agents connected"
    : `${featured.map((agent) => `${agent.label} ${WORD[agent.state]}`).join(" · ")}${overflowCount ? ` · +${overflowCount} more` : ""}${active.length === 0 ? " · all finished" : ""}`;
  return { agents: rows, featuredAgentIds: featured.map((agent) => agent.agentId), activeCount: active.length, overflowCount, headline };
}

export function sanitizePillCollaboration(value: unknown): PillCollaboration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<PillCollaboration>;
  if (!Array.isArray(raw.agents)) return undefined;
  const states = new Set<PillPresenceState>(["thinking", "asking", "preparing", "observing", "acting", "waiting", "blocked", "completed", "stopped"]);
  const agents = raw.agents.slice(0, 16).flatMap((rawAgent) => {
    if (!rawAgent || typeof rawAgent !== "object" || typeof rawAgent.agentId !== "string" || typeof rawAgent.label !== "string" || !states.has(rawAgent.state as PillPresenceState)) return [];
    const state = rawAgent.state as PillPresenceState;
    const cursor = rawAgent.cursor && states.has(rawAgent.cursor.mode as PillPresenceState)
      ? { mode: rawAgent.cursor.mode as PillPresenceState, visible: rawAgent.cursor.visible === true }
      : { mode: state, visible: !TERMINAL.has(state) };
    return [{
      agentId: rawAgent.agentId.slice(0, 128), label: rawAgent.label.slice(0, 80), provider: String(rawAgent.provider ?? "agent").slice(0, 48),
      color: /^#[0-9a-f]{6}$/i.test(rawAgent.color) ? rawAgent.color : stablePresenceColor(rawAgent.agentId), state, cursor,
      ...(typeof rawAgent.summary === "string" && rawAgent.summary ? { summary: rawAgent.summary.slice(0, 160) } : {}),
      ...(typeof rawAgent.surfaceId === "string" && rawAgent.surfaceId ? { surfaceId: rawAgent.surfaceId.slice(0, 128) } : {}),
      ...(typeof rawAgent.regionId === "string" && rawAgent.regionId ? { regionId: rawAgent.regionId.slice(0, 128) } : {}),
    } satisfies PillPresenceAgent];
  });
  const ids = new Set(agents.map((agent) => agent.agentId));
  const featuredAgentIds = (Array.isArray(raw.featuredAgentIds) ? raw.featuredAgentIds : []).filter((id): id is string => typeof id === "string" && ids.has(id)).slice(0, 3);
  const activeCount = Number.isSafeInteger(raw.activeCount) ? Math.max(0, Math.min(raw.activeCount as number, agents.length)) : agents.filter((agent) => agent.cursor.visible).length;
  const overflowCount = Number.isSafeInteger(raw.overflowCount) ? Math.max(0, Math.min(raw.overflowCount as number, agents.length)) : Math.max(0, agents.length - featuredAgentIds.length);
  return { agents, featuredAgentIds, activeCount, overflowCount, headline: typeof raw.headline === "string" ? raw.headline.slice(0, 240) : "" };
}
