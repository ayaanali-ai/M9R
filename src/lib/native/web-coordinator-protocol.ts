import type { CoordinatorEnvelope, CoordinatorMessageKind } from "./web-coordinator-core";

export interface CoordinatorMember {
  ownerId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

export interface CoordinatorSessionDescriptor {
  version: 1;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  members: readonly [CoordinatorMember, CoordinatorMember];
}

export interface CoordinatorSessionAcceptance {
  ownerId: string;
  signature: string;
}

export interface SignedCoordinatorSession {
  descriptor: CoordinatorSessionDescriptor;
  acceptances: CoordinatorSessionAcceptance[];
}

export interface SignedCoordinatorEnvelope extends CoordinatorEnvelope {
  signature: string;
}

export interface CoordinatorPollRequest {
  version: 1;
  sessionId: string;
  ownerId: string;
  createdAt: number;
  nonce: string;
  signature: string;
}

const encoder = new TextEncoder();

export function coordinatorSessionBytes(descriptor: CoordinatorSessionDescriptor): Uint8Array {
  const members = [...descriptor.members].sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  const canonical = JSON.stringify({ version: descriptor.version, sessionId: descriptor.sessionId, createdAt: descriptor.createdAt, expiresAt: descriptor.expiresAt, members });
  return encoder.encode(`M9R-WEB-COORDINATOR-SESSION-v1\n${canonical}`);
}

export function coordinatorEnvelopeBytes(frame: SignedCoordinatorEnvelope | Omit<SignedCoordinatorEnvelope, "signature">): Uint8Array {
  const canonical = JSON.stringify({
    version: frame.version,
    sessionId: frame.sessionId,
    fromOwner: frame.fromOwner,
    toOwner: frame.toOwner,
    sequence: frame.sequence,
    nonce: frame.nonce,
    createdAt: frame.createdAt,
    kind: frame.kind,
    sealedPayload: frame.sealedPayload,
  });
  return encoder.encode(`M9R-WEB-COORDINATOR-ENVELOPE-v1\n${canonical}`);
}

export function coordinatorPollBytes(request: Omit<CoordinatorPollRequest, "signature">): Uint8Array {
  return encoder.encode(`M9R-WEB-COORDINATOR-POLL-v1\n${JSON.stringify({ version: request.version, sessionId: request.sessionId, ownerId: request.ownerId, createdAt: request.createdAt, nonce: request.nonce })}`);
}

export type { CoordinatorEnvelope, CoordinatorMessageKind };
