/**
 * Pure participant-id helpers shared by the mission application and the
 * packaged local bridge. Keep these free of Supabase/application imports so
 * the CLI can ship the bridge without pulling the dashboard service tree.
 */
export function missionAgentParticipantId(missionId: string, connectionId: string): string {
  return `${missionId}-agent-${connectionId}`;
}
