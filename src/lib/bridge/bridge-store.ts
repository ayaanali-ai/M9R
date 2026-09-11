import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRIDGE_PROTOCOL_VERSION } from "./bridge-protocol";
import { canTransitionBridgeSession, type BridgeSessionRecord, type BridgeSessionState } from "./bridge-session-registry";
import { compareWorkspaceCursor } from "../mission/workspace-cursor";

export interface BridgeInstanceRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  repositoryId: string | null;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  softwareVersion: string;
  supportedProviders: string[];
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeDeadLetterInput {
  id: string;
  workspaceId: string;
  bridgeInstanceId: string;
  sessionId: string;
  conversationId: string;
  messageId: string;
  topic: string;
  reason: string;
  detail: string;
  queuedAt: string;
  createdAt: string;
}

export interface WorkspaceBridgeCursorRecord {
  workspaceId: string;
  bridgeInstanceId: string;
  conversationId: string;
  cursorCreatedAt: string;
  cursorMessageId: string;
  updatedAt: string;
}

export interface MissionBridgeStore {
  registerInstance(input: {
    id: string;
    workspaceId: string;
    ownerId: string;
    repositoryId: string | null;
    protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
    softwareVersion: string;
    supportedProviders: string[];
    now: string;
  }): Promise<BridgeInstanceRecord>;
  heartbeatInstance(input: { id: string; workspaceId: string; now: string }): Promise<BridgeInstanceRecord | null>;
  registerSession(input: {
    sessionId: string;
    bridgeInstanceId: string;
    workspaceId: string;
    missionId: string;
    participantId: string;
    providerAdapterId: string;
    providerSessionRef: string | null;
    capabilities: BridgeSessionRecord["capabilities"];
    now: string;
  }): Promise<BridgeSessionRecord>;
  transitionSession(input: { sessionId: string; bridgeInstanceId: string; workspaceId: string; nextState: BridgeSessionState; now: string }): Promise<BridgeSessionRecord | null>;
  touchSessions(input: { bridgeInstanceId: string; workspaceId: string; sessionIds: string[]; now: string }): Promise<number>;
  recordDeadLetter(input: BridgeDeadLetterInput): Promise<void>;
  getWorkspaceCursor(input: { workspaceId: string; bridgeInstanceId: string; ownerId: string; conversationId: string }): Promise<WorkspaceBridgeCursorRecord | null>;
  saveWorkspaceCursor(input: { workspaceId: string; bridgeInstanceId: string; ownerId: string; conversationId: string; cursorCreatedAt: string; cursorMessageId: string; now: string }): Promise<WorkspaceBridgeCursorRecord>;
}

export class InMemoryMissionBridgeStore implements MissionBridgeStore {
  private readonly instances = new Map<string, BridgeInstanceRecord>();
  private readonly sessions = new Map<string, BridgeSessionRecord>();
  private readonly deadLetters = new Map<string, BridgeDeadLetterInput>();
  private readonly workspaceCursors = new Map<string, WorkspaceBridgeCursorRecord>();

  async registerInstance(input: Parameters<MissionBridgeStore["registerInstance"]>[0]): Promise<BridgeInstanceRecord> {
    const current = this.instances.get(input.id);
    if (current && (current.workspaceId !== input.workspaceId || current.ownerId !== input.ownerId || current.revokedAt)) throw new Error("Bridge instance is owned by another principal or revoked.");
    const instance: BridgeInstanceRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      repositoryId: input.repositoryId,
      protocolVersion: input.protocolVersion,
      softwareVersion: input.softwareVersion,
      supportedProviders: [...input.supportedProviders],
      lastHeartbeatAt: current?.lastHeartbeatAt ?? null,
      revokedAt: current?.revokedAt ?? null,
      createdAt: current?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.instances.set(instance.id, instance);
    return instance;
  }

  async heartbeatInstance(input: { id: string; workspaceId: string; now: string }): Promise<BridgeInstanceRecord | null> {
    const current = this.instances.get(input.id);
    if (!current || current.workspaceId !== input.workspaceId || current.revokedAt) return null;
    const next = { ...current, lastHeartbeatAt: input.now, updatedAt: input.now };
    this.instances.set(next.id, next);
    return next;
  }

  async registerSession(input: Parameters<MissionBridgeStore["registerSession"]>[0]): Promise<BridgeSessionRecord> {
    const current = this.sessions.get(input.sessionId);
    const session: BridgeSessionRecord = {
      sessionId: input.sessionId,
      bridgeInstanceId: input.bridgeInstanceId,
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      participantId: input.participantId,
      providerAdapterId: input.providerAdapterId,
      providerSessionRef: input.providerSessionRef,
      state: current?.state ?? "registered",
      capabilities: { ...input.capabilities },
      lastHeartbeatAt: current?.lastHeartbeatAt ?? input.now,
      unreadDeliveryCount: current?.unreadDeliveryCount ?? 0,
      createdAt: current?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async transitionSession(input: { sessionId: string; bridgeInstanceId: string; workspaceId: string; nextState: BridgeSessionState; now: string }): Promise<BridgeSessionRecord | null> {
    const current = this.sessions.get(input.sessionId);
    if (!current || current.bridgeInstanceId !== input.bridgeInstanceId || current.workspaceId !== input.workspaceId) return null;
    if (!canTransitionBridgeSession(current.state, input.nextState)) return null;
    const next = { ...current, state: input.nextState, updatedAt: input.now };
    this.sessions.set(next.sessionId, next);
    return next;
  }

  async touchSessions(input: { bridgeInstanceId: string; workspaceId: string; sessionIds: string[]; now: string }): Promise<number> {
    let touched = 0;
    for (const sessionId of input.sessionIds) {
      const current = this.sessions.get(sessionId);
      if (!current || current.bridgeInstanceId !== input.bridgeInstanceId || current.workspaceId !== input.workspaceId) continue;
      this.sessions.set(sessionId, { ...current, lastHeartbeatAt: input.now, updatedAt: input.now });
      touched += 1;
    }
    return touched;
  }

  async recordDeadLetter(input: BridgeDeadLetterInput): Promise<void> {
    this.deadLetters.set(input.id, input);
  }

  async getWorkspaceCursor(input: Parameters<MissionBridgeStore["getWorkspaceCursor"]>[0]): Promise<WorkspaceBridgeCursorRecord | null> {
    const current = this.instances.get(input.bridgeInstanceId);
    if (!current || current.workspaceId !== input.workspaceId || current.ownerId !== input.ownerId || current.revokedAt) return null;
    return this.workspaceCursors.get(workspaceCursorKey(input)) ?? null;
  }

  async saveWorkspaceCursor(input: Parameters<MissionBridgeStore["saveWorkspaceCursor"]>[0]): Promise<WorkspaceBridgeCursorRecord> {
    const current = this.instances.get(input.bridgeInstanceId);
    if (!current || current.workspaceId !== input.workspaceId || current.ownerId !== input.ownerId || current.revokedAt) throw new Error("Bridge instance is owned by another principal or revoked.");
    const key = workspaceCursorKey(input);
    const next: WorkspaceBridgeCursorRecord = {
      workspaceId: input.workspaceId,
      bridgeInstanceId: input.bridgeInstanceId,
      conversationId: input.conversationId,
      cursorCreatedAt: input.cursorCreatedAt,
      cursorMessageId: input.cursorMessageId,
      updatedAt: input.now,
    };
    const existing = this.workspaceCursors.get(key);
    if (existing && compareWorkspaceCursor({ createdAt: existing.cursorCreatedAt, messageId: existing.cursorMessageId }, { createdAt: next.cursorCreatedAt, messageId: next.cursorMessageId }) >= 0) return existing;
    this.workspaceCursors.set(key, next);
    return next;
  }
}

export class SupabaseMissionBridgeStore implements MissionBridgeStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async getWorkspaceCursor(input: Parameters<MissionBridgeStore["getWorkspaceCursor"]>[0]): Promise<WorkspaceBridgeCursorRecord | null> {
    const instance = await this.authorizedInstance(input);
    if (!instance) return null;
    const { data, error } = await this.client.from("workspace_bridge_cursors")
      .select("workspace_id, bridge_instance_id, conversation_id, cursor_created_at, cursor_message_id, updated_at")
      .eq("workspace_id", input.workspaceId).eq("bridge_instance_id", input.bridgeInstanceId).eq("conversation_id", input.conversationId).maybeSingle();
    if (error) throw new Error("Failed to load workspace Bridge cursor: " + error.message);
    if (data) return fromWorkspaceCursorRow(data as Record<string, unknown>);
    // A brand-new bridgeInstanceId (every local resident restart mints one --
    // see local-mission-bridge-bootstrap.ts's own comment on why it's kept
    // random rather than fixed) has no cursor row of its own yet, which used
    // to mean "no cursor at all" -- so scanWorkspaceMessages fetched with no
    // `since` and got up to 200 historical messages, replaying old channel
    // history straight into the loop-signal counter on every restart.
    // Live-caught (Aug 25): four false "stuck in a loop" hard-stops, each
    // firing seconds after a restart, zero real agent messages in between.
    // The owner (this connection's durable identity, not the ephemeral
    // instance) is what actually continued the conversation last time, so
    // inherit the newest cursor from any of the owner's own past instances
    // instead of cold-starting -- this is deliberately NOT the same as
    // making bridgeInstanceId itself stable, so the presence/telemetry
    // concern that random ids protect against is untouched.
    // Bounded and newest-first: a long-lived connection accumulates one row
    // here per local resident restart -- confirmed live at 273 rows for a
    // single real connection after months of restarts, which blew the
    // unbounded .in() below past a real request-size limit and 500'd every
    // cursor lookup for that connection. Only the most recent restarts can
    // plausibly hold the cursor we'd actually want to inherit, so there is
    // no correctness lost by not fetching the other 250+.
    const PRIOR_INSTANCE_LOOKBACK = 25;
    const { data: ownedInstances, error: ownedError } = await this.client.from("bridge_instances")
      .select("id").eq("workspace_id", input.workspaceId).eq("owner_id", input.ownerId)
      .order("created_at", { ascending: false }).limit(PRIOR_INSTANCE_LOOKBACK);
    if (ownedError) throw new Error("Failed to look up this connection's prior Bridge instances: " + ownedError.message);
    const priorInstanceIds = (ownedInstances ?? []).map((row) => String((row as { id: unknown }).id)).filter((id) => id !== input.bridgeInstanceId);
    if (priorInstanceIds.length === 0) return null;
    const { data: priorRows, error: priorError } = await this.client.from("workspace_bridge_cursors")
      .select("workspace_id, bridge_instance_id, conversation_id, cursor_created_at, cursor_message_id, updated_at")
      .eq("workspace_id", input.workspaceId).eq("conversation_id", input.conversationId).in("bridge_instance_id", priorInstanceIds);
    if (priorError) throw new Error("Failed to load this connection's prior workspace Bridge cursor: " + priorError.message);
    const newest = (priorRows ?? []).map((row) => fromWorkspaceCursorRow(row as Record<string, unknown>))
      .reduce<WorkspaceBridgeCursorRecord | null>((best, candidate) =>
        !best || compareWorkspaceCursor({ createdAt: best.cursorCreatedAt, messageId: best.cursorMessageId }, { createdAt: candidate.cursorCreatedAt, messageId: candidate.cursorMessageId }) < 0 ? candidate : best, null);
    return newest;
  }

  async saveWorkspaceCursor(input: Parameters<MissionBridgeStore["saveWorkspaceCursor"]>[0]): Promise<WorkspaceBridgeCursorRecord> {
    const instance = await this.authorizedInstance(input);
    if (!instance) throw new Error("Bridge instance is owned by another principal or revoked.");
    const current = await this.getWorkspaceCursor(input);
    const incoming = { createdAt: input.cursorCreatedAt, messageId: input.cursorMessageId };
    if (current && compareWorkspaceCursor({ createdAt: current.cursorCreatedAt, messageId: current.cursorMessageId }, incoming) >= 0) return current;
    const { data, error } = await this.client.from("workspace_bridge_cursors").upsert({
      workspace_id: input.workspaceId,
      bridge_instance_id: input.bridgeInstanceId,
      conversation_id: input.conversationId,
      cursor_created_at: input.cursorCreatedAt,
      cursor_message_id: input.cursorMessageId,
      updated_at: input.now,
    }, { onConflict: "workspace_id,bridge_instance_id,conversation_id" }).select("workspace_id, bridge_instance_id, conversation_id, cursor_created_at, cursor_message_id, updated_at").single();
    if (error || !data) throw new Error("Failed to save workspace Bridge cursor: " + (error?.message ?? "no row returned"));
    return fromWorkspaceCursorRow(data as Record<string, unknown>);
  }

  private async authorizedInstance(input: { workspaceId: string; bridgeInstanceId: string; ownerId: string }): Promise<{ id: string } | null> {
    const { data, error } = await this.client.from("bridge_instances").select("id")
      .eq("id", input.bridgeInstanceId).eq("workspace_id", input.workspaceId).eq("owner_id", input.ownerId).is("revoked_at", null).maybeSingle();
    if (error) throw new Error("Failed to inspect Agent Bridge ownership: " + error.message);
    return data ? { id: String(data.id) } : null;
  }

  async registerInstance(input: Parameters<MissionBridgeStore["registerInstance"]>[0]): Promise<BridgeInstanceRecord> {
    const { data: existing, error: existingError } = await this.client.from("bridge_instances").select("workspace_id, owner_id, revoked_at").eq("id", input.id).maybeSingle();
    if (existingError) throw new Error(`Failed to inspect Agent Bridge ownership: ${existingError.message}`);
    if (existing && (String(existing.workspace_id) !== input.workspaceId || String(existing.owner_id) !== input.ownerId || existing.revoked_at != null)) throw new Error("Bridge instance is owned by another principal or revoked.");
    const { data, error } = await this.client.from("bridge_instances").upsert({
      id: input.id,
      workspace_id: input.workspaceId,
      owner_id: input.ownerId,
      repository_id: input.repositoryId,
      protocol_version: input.protocolVersion,
      software_version: input.softwareVersion,
      supported_providers: input.supportedProviders,
      updated_at: input.now,
    }, { onConflict: "id" }).select("*").single();
    if (error) throw new Error(`Failed to register Agent Bridge: ${error.message}`);
    return fromInstanceRow(data as Record<string, unknown>);
  }

  async heartbeatInstance(input: { id: string; workspaceId: string; now: string }): Promise<BridgeInstanceRecord | null> {
    const { data, error } = await this.client.from("bridge_instances").update({ last_heartbeat_at: input.now, updated_at: input.now }).eq("id", input.id).eq("workspace_id", input.workspaceId).is("revoked_at", null).select("*").maybeSingle();
    if (error) throw new Error(`Failed to update Agent Bridge heartbeat: ${error.message}`);
    return data ? fromInstanceRow(data as Record<string, unknown>) : null;
  }

  async recordDeadLetter(input: BridgeDeadLetterInput): Promise<void> {
    const { error } = await this.client.from("mission_bridge_dead_letters").upsert({
      id: input.id,
      workspace_id: input.workspaceId,
      bridge_instance_id: input.bridgeInstanceId,
      session_id: input.sessionId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      topic: input.topic,
      reason: input.reason,
      detail: input.detail,
      queued_at: input.queuedAt,
      created_at: input.createdAt,
    }, { onConflict: "id" });
    if (error) throw new Error(`Failed to persist Mission Bridge dead letter: ${error.message}`);
  }

  async registerSession(input: Parameters<MissionBridgeStore["registerSession"]>[0]): Promise<BridgeSessionRecord> {
    const { data, error } = await this.client.from("mission_agent_sessions").upsert({
      id: input.sessionId,
      workspace_id: input.workspaceId,
      mission_id: input.missionId,
      participant_id: input.participantId,
      bridge_instance_id: input.bridgeInstanceId,
      provider_adapter_id: input.providerAdapterId,
      provider_session_ref: input.providerSessionRef,
      state: "registered",
      capabilities: input.capabilities,
      last_event_at: input.now,
      updated_at: input.now,
    }, { onConflict: "id" }).select("*").single();
    if (error) throw new Error(`Failed to register Agent Bridge session: ${error.message}`);
    return fromSessionRow(data as Record<string, unknown>);
  }

  async transitionSession(input: { sessionId: string; bridgeInstanceId: string; workspaceId: string; nextState: BridgeSessionState; now: string }): Promise<BridgeSessionRecord | null> {
    const { data: currentData, error: currentError } = await this.client.from("mission_agent_sessions").select("state").eq("id", input.sessionId).eq("bridge_instance_id", input.bridgeInstanceId).eq("workspace_id", input.workspaceId).maybeSingle();
    if (currentError) throw new Error(`Failed to load Agent Bridge session: ${currentError.message}`);
    if (!currentData || !canTransitionBridgeSession(String(currentData.state) as BridgeSessionState, input.nextState)) return null;
    const { data, error } = await this.client.from("mission_agent_sessions").update({ state: input.nextState, updated_at: input.now }).eq("id", input.sessionId).eq("bridge_instance_id", input.bridgeInstanceId).eq("workspace_id", input.workspaceId).eq("state", currentData.state).select("*").maybeSingle();
    if (error) throw new Error(`Failed to transition Agent Bridge session: ${error.message}`);
    return data ? fromSessionRow(data as Record<string, unknown>) : null;
  }

  async touchSessions(input: { bridgeInstanceId: string; workspaceId: string; sessionIds: string[]; now: string }): Promise<number> {
    if (input.sessionIds.length === 0) return 0;
    const { data, error } = await this.client.from("mission_agent_sessions").update({ last_event_at: input.now, updated_at: input.now }).eq("bridge_instance_id", input.bridgeInstanceId).eq("workspace_id", input.workspaceId).in("id", input.sessionIds).select("id");
    if (error) throw new Error(`Failed to update Agent Bridge session heartbeat: ${error.message}`);
    return data?.length ?? 0;
  }
}

function workspaceCursorKey(input: { workspaceId: string; bridgeInstanceId: string; conversationId: string }): string {
  return input.workspaceId + "\u0000" + input.bridgeInstanceId + "\u0000" + input.conversationId;
}

function fromWorkspaceCursorRow(row: Record<string, unknown>): WorkspaceBridgeCursorRecord {
  return {
    workspaceId: String(row.workspace_id),
    bridgeInstanceId: String(row.bridge_instance_id),
    conversationId: String(row.conversation_id),
    cursorCreatedAt: String(row.cursor_created_at),
    cursorMessageId: String(row.cursor_message_id),
    updatedAt: String(row.updated_at),
  };
}

function fromInstanceRow(row: Record<string, unknown>): BridgeInstanceRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    repositoryId: row.repository_id == null ? null : String(row.repository_id),
    protocolVersion: String(row.protocol_version) as typeof BRIDGE_PROTOCOL_VERSION,
    softwareVersion: String(row.software_version ?? ""),
    supportedProviders: Array.isArray(row.supported_providers) ? row.supported_providers.map(String).slice(0, 32) : [],
    lastHeartbeatAt: row.last_heartbeat_at == null ? null : String(row.last_heartbeat_at),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromSessionRow(row: Record<string, unknown>): BridgeSessionRecord {
  const capabilities = row.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities) ? row.capabilities as BridgeSessionRecord["capabilities"] : {};
  return {
    sessionId: String(row.id),
    bridgeInstanceId: String(row.bridge_instance_id),
    workspaceId: String(row.workspace_id),
    missionId: String(row.mission_id),
    participantId: String(row.participant_id),
    providerAdapterId: String(row.provider_adapter_id),
    providerSessionRef: row.provider_session_ref == null ? null : String(row.provider_session_ref),
    state: String(row.state) as BridgeSessionState,
    capabilities,
    lastHeartbeatAt: row.last_event_at == null ? null : String(row.last_event_at),
    unreadDeliveryCount: 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createSupabaseMissionBridgeStore(): SupabaseMissionBridgeStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionBridgeStore(supabase);
}
