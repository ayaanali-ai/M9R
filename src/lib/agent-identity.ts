// src/lib/agent-identity.ts
// Display name helper for agent connections

import type { ConnectionForRoster } from '@/lib/peer-roster';

export function getAgentDisplayName(connection: ConnectionForRoster): string {
  if (connection.display_name) return connection.display_name;
  const owner = connection.owner_name || 'Unknown';
  const kind = connection.agent_kind.charAt(0).toUpperCase() + connection.agent_kind.slice(1);
  return `${owner}'s ${kind}`;
}

export function getAgentMentionName(connection: ConnectionForRoster): string {
  // For @mention autocomplete — clipped, no brackets
  return getAgentDisplayName(connection).replace(/[\[\]]/g, ' ').slice(0, 80);
}