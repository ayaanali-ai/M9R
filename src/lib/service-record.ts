/**
 * Service Record — OathLock V2 Phase 7
 * ----------------------------------------------------------------------------
 * The reviewed participation history of a Callsign. NOT a reputation score —
 * no leaderboard, no "rank #1", no aggregate number implying quality. Just
 * counts of things that actually happened, with an honest "not tracked yet"
 * for concepts this codebase doesn't build yet (Bounded Assistance /
 * supporting contributions — Phase 8).
 */

export interface ServiceRecordCounts {
  runsParticipated: number;
  runsNeedingFollowUp: number;
  findingsPublished: number;
  findingsAdopted: number;
  lastActiveAt: string | null;
}

export interface ServiceRecordView extends ServiceRecordCounts {
  /**
   * Supporting-run contributions (Bounded Assistance, Phase 8) are not built
   * yet — this is explicitly null, never fabricated as 0-and-hidden.
   */
  supportingContributions: null;
}

export function buildServiceRecord(counts: ServiceRecordCounts): ServiceRecordView {
  return { ...counts, supportingContributions: null };
}
