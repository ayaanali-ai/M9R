import type { ProviderCapabilities } from "@/lib/mission/mission-provider-adapter";
import type { InteractiveProviderCapability } from "./interactive-provider-adapter";

export const BRIDGE_SESSION_STATES = ["registered", "launching", "initializing", "ready", "working", "waiting", "blocked", "interrupted", "resuming", "closed"] as const;
export type BridgeSessionState = (typeof BRIDGE_SESSION_STATES)[number];

export interface BridgeSessionRecord {
  sessionId: string;
  bridgeInstanceId: string;
  workspaceId: string;
  missionId: string;
  participantId: string;
  providerAdapterId: string;
  providerSessionRef: string | null;
  /** Best-effort: this session's own ACP server's real, live model choices (see AgentSessionHandle). Null when the provider exposes none -- never a guessed/hardcoded list. */
  availableModels?: { id: string; label: string }[] | null;
  state: BridgeSessionState;
  capabilities: Partial<ProviderCapabilities> & Partial<Record<InteractiveProviderCapability, boolean>>;
  lastHeartbeatAt: string | null;
  unreadDeliveryCount: number;
  createdAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<BridgeSessionState, readonly BridgeSessionState[]> = {
  registered: ["launching", "closed"],
  launching: ["initializing", "interrupted", "blocked", "closed"],
  initializing: ["ready", "interrupted", "blocked", "closed"],
  ready: ["working", "waiting", "resuming", "interrupted", "closed"],
  working: ["ready", "waiting", "blocked", "interrupted", "closed"],
  waiting: ["working", "ready", "blocked", "resuming", "closed"],
  blocked: ["resuming", "interrupted", "closed"],
  interrupted: ["resuming", "closed"],
  resuming: ["ready", "working", "blocked", "interrupted", "closed"],
  closed: [],
};

export function canTransitionBridgeSession(current: BridgeSessionState, next: BridgeSessionState): boolean {
  return TRANSITIONS[current].includes(next);
}

export class BridgeSessionRegistry {
  private readonly sessions = new Map<string, BridgeSessionRecord>();

  register(input: Omit<BridgeSessionRecord, "state" | "lastHeartbeatAt" | "unreadDeliveryCount" | "createdAt" | "updatedAt"> & Partial<Pick<BridgeSessionRecord, "createdAt" | "updatedAt">>): BridgeSessionRecord {
    if (this.sessions.has(input.sessionId)) throw new Error("Bridge session already exists.");
    const now = new Date().toISOString();
    const session: BridgeSessionRecord = {
      ...input,
      state: "registered",
      lastHeartbeatAt: null,
      unreadDeliveryCount: 0,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): BridgeSessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  listMissionSessions(workspaceId: string, missionId: string): BridgeSessionRecord[] {
    return [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId && session.missionId === missionId);
  }

  list(): BridgeSessionRecord[] {
    return [...this.sessions.values()];
  }

  transition(sessionId: string, nextState: BridgeSessionState, now = new Date().toISOString()): { ok: true; session: BridgeSessionRecord } | { ok: false; reason: string } {
    const current = this.sessions.get(sessionId);
    if (!current) return { ok: false, reason: "session_not_found" };
    if (!canTransitionBridgeSession(current.state, nextState)) return { ok: false, reason: `Session cannot move from '${current.state}' to '${nextState}'.` };
    const next = { ...current, state: nextState, updatedAt: now };
    this.sessions.set(sessionId, next);
    return { ok: true, session: next };
  }

  heartbeat(sessionId: string, now: string): BridgeSessionRecord | null {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const next = { ...current, lastHeartbeatAt: now, updatedAt: now };
    this.sessions.set(sessionId, next);
    return next;
  }

  updateProviderSession(sessionId: string, input: { providerSessionRef: string | null; capabilities?: BridgeSessionRecord["capabilities"] }): BridgeSessionRecord | null {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const next = {
      ...current,
      providerSessionRef: input.providerSessionRef,
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    return next;
  }
}
