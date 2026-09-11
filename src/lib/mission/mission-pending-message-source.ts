import type { MissionMessage, ParticipantId } from "./mission-domain";
import { pendingMessagesFor, renderPendingMessagesForLaunch } from "./mission-collaboration-bridge";
import { projectMission, queryMissionMessages } from "./mission-projection";
import type { SupabaseMissionEventReader } from "./mission-store-supabase";

export interface MissionPendingMessageSource {
  loadPendingMessages(input: { missionId: string; participantId: ParticipantId; since: string | null }): Promise<string | null>;
}

export class SupabaseMissionPendingMessageSource implements MissionPendingMessageSource {
  private readonly reader: SupabaseMissionEventReader;

  constructor(reader: SupabaseMissionEventReader) {
    this.reader = reader;
  }

  async loadPendingMessages(input: { missionId: string; participantId: ParticipantId; since: string | null }): Promise<string | null> {
    const events = await this.reader.loadEvents(input.missionId);
    const projection = projectMission(input.missionId, events);
    const messages: MissionMessage[] = [];
    let cursor: number | null = null;
    do {
      const page = queryMissionMessages(events, { cursor, limit: 200 });
      messages.push(...page.messages);
      cursor = page.nextCursor;
    } while (cursor !== null);
    // `projectMission` is intentionally computed above so a future bounded
    // source can assert the Mission identity before exposing messages. The
    // full message query remains the authoritative history for pending work.
    if (projection.missionId !== input.missionId) throw new Error("Mission pending-message source returned the wrong Mission.");
    return renderPendingMessagesForLaunch(pendingMessagesFor(messages, input.participantId, input.since));
  }
}
