/**
 * Buzz-parity chat entry point: a channel message that @mentions an agent
 * implicitly creates (once) or reuses the one Mission bound to that channel —
 * there is no separate "create Mission" form in this path. Mirrors Buzz's
 * `message_posted` trigger firing work directly (see ARCHITECTURE.md), with
 * OathLock's governance (participants, scope, evidence, Passport) riding on
 * top of the same Mission domain that already exists.
 *
 * A channel with no `repository` bound never gets an implicit Mission — the
 * Mission domain requires one, and this module refuses to guess it rather
 * than attach work to the wrong repo. See mission-feature-flags.ts's
 * `channelMissionBinding` flag: this whole path is opt-in until proven safe
 * against the legacy conversation flow it sits beside, never replaces.
 */

import { supabase } from "@/lib/supabase";
import { createMission, addMissionParticipant, getMissionConversation, type MissionSummaryDto } from "./mission-application-service";
import { MissionApiError } from "./mission-application-errors";
import type { MissionPrincipal } from "./mission-principal";
import type { AgentKindKey } from "@/lib/agent-workspace-data";
import { missionAgentParticipantId } from "./mission-participant-ids";
export { missionAgentParticipantId };

export interface ChannelMentionedAgent {
  connectionId: string;
  agentKind: AgentKindKey;
  displayName: string;
  provider: string;
}

export interface EnsureChannelMissionInput {
  principal: MissionPrincipal;
  conversationId: string;
  existingMissionId: string | null;
  repository: string;
  repositoryId: string | null;
  goal: string;
  humanDisplayName: string;
  mentionedAgents: ChannelMentionedAgent[];
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

export function missionIdForConversation(conversationId: string): string {
  return `channel-${conversationId}`;
}

export function missionOwnerParticipantId(missionId: string, userId: string): string {
  return `${missionId}-owner-${userId}`;
}

async function addParticipantIfMissing(principal: MissionPrincipal, input: Parameters<typeof addMissionParticipant>[1], knownParticipantIds: Set<string>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (knownParticipantIds.has(input.participantId)) return;
    try {
      await addMissionParticipant(principal, input);
      knownParticipantIds.add(input.participantId);
      return;
    } catch (error) {
      // Two messages can mention the same new agent concurrently. The command
      // boundary rejects the second AddParticipant, which is safe to treat as
      // an idempotent success because the participant now exists durably.
      if (error instanceof MissionApiError && error.code === "participant_already_exists") {
        knownParticipantIds.add(input.participantId);
        return;
      }
      if (!(error instanceof MissionApiError) || error.code !== "version_conflict" || attempt > 0) throw error;
      // Refresh once and retry against the new aggregate version. This keeps
      // concurrent first mentions from losing one of several agent members.
      const current = await getMissionConversation(principal, input.missionId, { limit: 1 });
      for (const participant of current.participants) knownParticipantIds.add(participant.id);
    }
  }
}

/**
 * Idempotent: safe to call on every message. Existing channel Missions are
 * reconciled with newly mentioned connections instead of returning early;
 * that is what lets a 20-agent workspace grow its participant set over time.
 */
export async function ensureChannelMission(input: EnsureChannelMissionInput): Promise<{ missionId: string; created: boolean }> {
  const missionId = input.existingMissionId ?? missionIdForConversation(input.conversationId);
  const created = !input.existingMissionId;
  const knownParticipantIds = new Set<string>();

  if (created) {
    await createMission(input.principal, {
      missionId,
      repository: input.repository,
      repositoryId: input.repositoryId,
      goal: input.goal,
      mode: "coordinated",
      clientRequestId: `channel-binding:${input.conversationId}:create`,
    });
  } else {
    const conversation = await getMissionConversation(input.principal, missionId, { limit: 1 });
    for (const participant of conversation.participants) knownParticipantIds.add(participant.id);
  }

  await addParticipantIfMissing(input.principal, {
    missionId,
    participantId: missionOwnerParticipantId(missionId, input.principal.userId ?? "human"),
    kind: "human",
    role: "owner",
    displayName: input.humanDisplayName,
    agentKind: null,
    provider: null,
    adapterId: null,
    communicationPermissions: { canBroadcast: true, canDelegate: true, maxDelegationDepth: 2 },
    activate: true,
    clientRequestId: `channel-binding:${input.conversationId}:owner`,
  }, knownParticipantIds);

  for (const agent of input.mentionedAgents) {
    await addParticipantIfMissing(input.principal, {
      missionId,
      participantId: missionAgentParticipantId(missionId, agent.connectionId),
      kind: "agent",
      role: "implementer",
      displayName: agent.displayName,
      agentKind: agent.agentKind,
      provider: agent.provider,
      adapterId: null,
      capabilities: ["non_interactive_execution", "repository_editing"],
      communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 1 },
      activate: true,
      clientRequestId: `channel-binding:${input.conversationId}:agent:${agent.connectionId}`,
    }, knownParticipantIds);
  }

  if (created) {
    const db = requireService();
    const { error } = await db.from("agent_conversations").update({ mission_id: missionId }).eq("id", input.conversationId).is("mission_id", null);
    if (error) throw new Error(`Mission ${missionId} was created but could not be bound to channel ${input.conversationId}: ${error.message}`);
  }

  return { missionId, created };
}

export type { MissionSummaryDto };
