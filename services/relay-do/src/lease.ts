/**
 * Presence lease for Bridges (M9R_NETWORK_SPEC.md 5.1: a 90 second lease, server time authoritative).
 *
 * A Bridge that crashes or loses power never sends `offline`, and a half-open socket can linger long after
 * the peer is gone, leaving a ghost in the room's live presence. Every Bridge sends `bridge.heartbeat` every
 * ~20 s, so a socket that has heartbeated at least once and then goes silent for a full lease is closed; the
 * normal disconnect path then removes its presence and tells the room. Sockets that never heartbeat (browsers)
 * are never swept: a background tab is quiet, not dead.
 *
 * Pure so it can be tested without the Workers runtime.
 */
export const PRESENCE_LEASE_MS = 90_000;
export const LEASE_SWEEP_INTERVAL_MS = 30_000;
export const HEARTBEAT_FRAME_TYPE = "bridge.heartbeat";

export interface LeaseTracked {
  id: string;
  heartbeating: boolean;
  lastInboundAt: number;
}

export function expiredHeartbeatingConnections<T extends LeaseTracked>(connections: Iterable<T>, now: number, leaseMs: number = PRESENCE_LEASE_MS): T[] {
  const expired: T[] = [];
  for (const connection of connections) {
    if (connection.heartbeating && now - connection.lastInboundAt > leaseMs) expired.push(connection);
  }
  return expired;
}

export function anyHeartbeating(connections: Iterable<LeaseTracked>): boolean {
  for (const connection of connections) if (connection.heartbeating) return true;
  return false;
}
