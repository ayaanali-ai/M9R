/**
 * Pure relay state for the future cross-owner web coordinator. It accepts only opaque, end-to-end sealed payloads;
 * the Durable Object adapter must authenticate the transport peer before calling route(). Local web authority stays
 * on each owner's node and is never represented in this coordinator state.
 */

export type CoordinatorMessageKind = "web.command" | "web.result" | "web.presence";

export interface CoordinatorEnvelope {
  version: 1;
  sessionId: string;
  fromOwner: string;
  toOwner: string;
  sequence: number;
  nonce: string;
  createdAt: number;
  kind: CoordinatorMessageKind;
  sealedPayload: string;
}

export type CoordinatorDecision = { accepted: true; deliveredTo: number } | { accepted: false; reason: string };

export const COORDINATOR_MAX_SEALED_PAYLOAD = 64 * 1024;

function fail(reason: string): CoordinatorDecision {
  return { accepted: false, reason };
}

export function validateCoordinatorEnvelope(value: unknown): string | null {
  if (!value || typeof value !== "object") return "frame must be an object";
  const frame = value as Partial<CoordinatorEnvelope>;
  if (frame.version !== 1) return "unsupported frame version";
  if (typeof frame.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.sessionId)) return "invalid session id";
  if (typeof frame.fromOwner !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(frame.fromOwner)) return "invalid sender owner";
  if (typeof frame.toOwner !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(frame.toOwner)) return "invalid recipient owner";
  if (frame.fromOwner === frame.toOwner) return "sender and recipient must differ";
  if (!Number.isSafeInteger(frame.sequence) || (frame.sequence ?? 0) < 1) return "sequence must be a positive safe integer";
  if (typeof frame.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(frame.nonce)) return "invalid replay nonce";
  if (!Number.isSafeInteger(frame.createdAt)) return "invalid creation time";
  if (frame.kind !== "web.command" && frame.kind !== "web.result" && frame.kind !== "web.presence") return "unsupported message kind";
  if (typeof frame.sealedPayload !== "string" || frame.sealedPayload.length < 16 || frame.sealedPayload.length > COORDINATOR_MAX_SEALED_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(frame.sealedPayload)) {
    return "sealed payload must be bounded base64url ciphertext";
  }
  return null;
}

export function createWebCoordinatorCore(options: { now?: () => number; maxClockSkewMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const maxClockSkewMs = options.maxClockSkewMs ?? 90_000;
  const sessions = new Map<string, { owners: readonly [string, string]; expiresAt: number }>();
  const connections = new Map<string, Set<(frame: CoordinatorEnvelope) => void>>();
  const lastSequences = new Map<string, number>();
  const nonces = new Map<string, number>();

  function registerSession(input: { sessionId: string; owners: readonly [string, string]; expiresAt: number }): boolean {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId) || input.owners[0] === input.owners[1] || input.expiresAt <= now()) return false;
    const current = sessions.get(input.sessionId);
    if (current) return current.owners[0] === input.owners[0] && current.owners[1] === input.owners[1] && current.expiresAt === input.expiresAt;
    sessions.set(input.sessionId, { owners: [...input.owners], expiresAt: input.expiresAt });
    return true;
  }

  function attach(ownerId: string, send: (frame: CoordinatorEnvelope) => void): () => void {
    const peers = connections.get(ownerId) ?? new Set<(frame: CoordinatorEnvelope) => void>();
    peers.add(send);
    connections.set(ownerId, peers);
    return () => {
      peers.delete(send);
      if (peers.size === 0) connections.delete(ownerId);
    };
  }

  function route(authenticatedOwner: string, frame: CoordinatorEnvelope): CoordinatorDecision {
    const invalid = validateCoordinatorEnvelope(frame);
    if (invalid) return fail(invalid);
    if (authenticatedOwner !== frame.fromOwner) return fail("authenticated owner does not match frame sender");
    const session = sessions.get(frame.sessionId);
    if (!session || session.expiresAt <= now()) return fail("session is unknown or expired");
    if (!session.owners.includes(frame.fromOwner) || !session.owners.includes(frame.toOwner)) return fail("owner is not a member of this session");
    if (Math.abs(now() - frame.createdAt) > maxClockSkewMs) return fail("frame is outside the accepted time window");
    const stream = `${frame.sessionId}:${frame.fromOwner}`;
    if (frame.sequence <= (lastSequences.get(stream) ?? 0)) return fail("sequence was replayed or arrived out of order");
    for (const [nonce, at] of nonces) if (now() - at > maxClockSkewMs * 2) nonces.delete(nonce);
    const replayKey = `${stream}:${frame.nonce}`;
    if (nonces.has(replayKey)) return fail("nonce was replayed");
    const peers = connections.get(frame.toOwner);
    if (!peers?.size) return fail("recipient owner is offline");
    lastSequences.set(stream, frame.sequence);
    nonces.set(replayKey, now());
    for (const send of peers) send({ ...frame });
    return { accepted: true, deliveredTo: peers.size };
  }

  return { registerSession, attach, route };
}
