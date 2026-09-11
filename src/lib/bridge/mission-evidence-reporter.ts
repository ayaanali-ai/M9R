/**
 * Turns a live ACP session's structured runtime events into Mission
 * evidence (plan §B8-followup / Item 2). Before this, evidence recording
 * only ever happened for the one-shot dispatch path
 * (mission-execution-result-processor.ts) — an interactive ACP session's
 * work never reached mission_events at all, so buildMissionPassport had
 * nothing to show for it even though it reads evidence generically.
 *
 * Deliberately narrow: only a COMPLETED file change or command result
 * becomes evidence — never a bare "started"/"read" event (nothing to show
 * yet) and never raw prose (mapAcpSessionUpdate already refuses to promote
 * agent prose to structured activity; this module inherits that
 * discipline rather than working around it).
 */

import type { BridgeRuntimeEventSinkInput } from "./acp-client";
import type { EvidenceNoticeKind } from "@/lib/mission/mission-domain";

interface ActivityPayload {
  activityKind?: string;
  status?: string;
  summary?: string;
  filePath?: string | null;
  command?: string | null;
}

export interface RuntimeEvidenceCandidate {
  missionId: string;
  participantId: string;
  executionId: string;
  assignmentId: string | null;
  provider: string;
  kind: EvidenceNoticeKind;
  source: string;
}

/** Pure mapping — returns null for events that aren't evidence-worthy (started/read, or unrecognized types). */
export function evidenceCandidateFromRuntimeEvent(input: BridgeRuntimeEventSinkInput): RuntimeEvidenceCandidate | null {
  if (input.event.type !== "provider.activity") return null;
  const payload = input.event.payload as ActivityPayload;
  if (payload.activityKind === "file.changed") {
    return {
      missionId: input.session.missionId,
      participantId: input.session.participantId,
      executionId: input.executionId,
      assignmentId: input.assignmentId,
      provider: input.session.providerAdapterId,
      kind: "diff_or_patch",
      source: payload.filePath ? `Edited ${payload.filePath}` : (payload.summary ?? "Provider changed a file"),
    };
  }
  if (payload.activityKind === "command.completed") {
    return {
      missionId: input.session.missionId,
      participantId: input.session.participantId,
      executionId: input.executionId,
      assignmentId: input.assignmentId,
      provider: input.session.providerAdapterId,
      kind: "test_result",
      source: payload.command ? `Ran: ${payload.command.slice(0, 500)}` : (payload.summary ?? "Provider ran a command"),
    };
  }
  return null;
}

/** Best-effort by design — never lets an evidence-reporting failure interrupt the live session it's observing. */
export async function reportRuntimeEvidence(input: { appUrl: string; agentToken: string; event: BridgeRuntimeEventSinkInput }): Promise<void> {
  const candidate = evidenceCandidateFromRuntimeEvent(input.event);
  if (!candidate) return;
  try {
    const response = await fetch(`${input.appUrl.replace(/\/$/, "")}/api/missions/${encodeURIComponent(candidate.missionId)}/evidence`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${input.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        assignmentId: candidate.assignmentId,
        producerParticipantId: candidate.participantId,
        producerKind: "agent",
        executionId: candidate.executionId,
        provider: candidate.provider,
        kind: candidate.kind,
        source: candidate.source,
        lifecycle: "captured",
        availability: "available",
      }),
    });
    if (!response.ok) console.error(`Evidence report failed for Mission ${candidate.missionId}: HTTP ${response.status}`);
  } catch (error) {
    console.error(`Evidence report failed for Mission ${candidate.missionId}:`, error instanceof Error ? error.message : error);
  }
}
