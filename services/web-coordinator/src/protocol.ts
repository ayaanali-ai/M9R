import { validateCoordinatorEnvelope } from "../../../src/lib/native/web-coordinator-core";
import { coordinatorEnvelopeBytes, coordinatorPollBytes, coordinatorSessionBytes, type CoordinatorMember, type CoordinatorPollRequest, type CoordinatorSessionAcceptance, type CoordinatorSessionDescriptor, type SignedCoordinatorEnvelope, type SignedCoordinatorSession } from "../../../src/lib/native/web-coordinator-protocol";

export type { CoordinatorMember, CoordinatorPollRequest, CoordinatorSessionAcceptance, CoordinatorSessionDescriptor, SignedCoordinatorEnvelope, SignedCoordinatorSession };

export const COORDINATOR_CLOCK_SKEW_MS = 90_000;
export const COORDINATOR_MAX_SESSION_MS = 24 * 60 * 60 * 1_000;
export const COORDINATOR_MAX_QUEUE = 100;

const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

async function ownerIdForKey(key: string): Promise<string | null> {
  const bytes = decodeBase64Url(key);
  if (!bytes || bytes.length !== 44 || bytes[0] !== 0x30 || bytes[1] !== 0x2a || bytes[4] !== 0x06 || bytes[5] !== 0x03 || bytes[6] !== 0x2b || bytes[7] !== 0x65 || bytes[8] !== 0x70 || bytes[9] !== 0x03 || bytes[10] !== 0x21 || bytes[11] !== 0x00) return null;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyEd25519(member: CoordinatorMember, bytes: Uint8Array, signature: string): Promise<boolean> {
  const keyBytes = decodeBase64Url(member.signingPublicKey);
  const signatureBytes = decodeBase64Url(signature);
  if (!keyBytes || keyBytes.length !== 44 || !signatureBytes || signatureBytes.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("spki", new Uint8Array(keyBytes), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signatureBytes), new Uint8Array(bytes));
  } catch {
    return false;
  }
}

function isMember(value: unknown): value is CoordinatorMember {
  if (!value || typeof value !== "object") return false;
  const member = value as Record<string, unknown>;
  return typeof member.ownerId === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(member.ownerId)
    && typeof member.signingPublicKey === "string" && member.signingPublicKey.length <= 512
    && typeof member.encryptionPublicKey === "string" && member.encryptionPublicKey.length <= 512;
}

export async function verifyCoordinatorSession(value: unknown, now = Date.now()): Promise<{ ok: true; session: SignedCoordinatorSession } | { ok: false; error: string }> {
  if (!value || typeof value !== "object") return { ok: false, error: "session registration must be an object" };
  const session = value as Partial<SignedCoordinatorSession>;
  const descriptor = session.descriptor;
  if (!descriptor || descriptor.version !== 1 || typeof descriptor.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.sessionId)) return { ok: false, error: "invalid session descriptor" };
  if (!Number.isSafeInteger(descriptor.createdAt) || !Number.isSafeInteger(descriptor.expiresAt) || descriptor.createdAt > now + COORDINATOR_CLOCK_SKEW_MS || descriptor.expiresAt <= now || descriptor.expiresAt - descriptor.createdAt > COORDINATOR_MAX_SESSION_MS) return { ok: false, error: "session is expired or outside its permitted lifetime" };
  if (!Array.isArray(descriptor.members) || descriptor.members.length !== 2 || !descriptor.members.every(isMember)) return { ok: false, error: "a session requires exactly two valid owner key bundles" };
  const [first, second] = descriptor.members;
  if (first.ownerId === second.ownerId) return { ok: false, error: "session owners must be distinct" };
  for (const member of descriptor.members) {
    const expected = await ownerIdForKey(member.signingPublicKey);
    if (!expected || expected !== member.ownerId) return { ok: false, error: "owner id does not match its signing key" };
    const encryptionKey = decodeBase64Url(member.encryptionPublicKey);
    if (!encryptionKey || encryptionKey.length !== 44 || encryptionKey[0] !== 0x30 || encryptionKey[1] !== 0x2a || encryptionKey[4] !== 0x06 || encryptionKey[5] !== 0x03 || encryptionKey[6] !== 0x2b || encryptionKey[7] !== 0x65 || encryptionKey[8] !== 0x6e || encryptionKey[9] !== 0x03 || encryptionKey[10] !== 0x21 || encryptionKey[11] !== 0x00) return { ok: false, error: "invalid X25519 owner encryption key" };
  }
  if (!Array.isArray(session.acceptances) || session.acceptances.length !== 2) return { ok: false, error: "both owners must sign the session descriptor" };
  const acceptanceByOwner = new Map<string, CoordinatorSessionAcceptance>();
  for (const acceptance of session.acceptances) {
    if (!acceptance || typeof acceptance.ownerId !== "string" || typeof acceptance.signature !== "string" || acceptanceByOwner.has(acceptance.ownerId)) return { ok: false, error: "invalid or duplicate session acceptance" };
    acceptanceByOwner.set(acceptance.ownerId, acceptance);
  }
  for (const member of descriptor.members) {
    const acceptance = acceptanceByOwner.get(member.ownerId);
    if (!acceptance || !(await verifyEd25519(member, coordinatorSessionBytes(descriptor), acceptance.signature))) return { ok: false, error: "a required owner signature is missing or invalid" };
  }
  return { ok: true, session: session as SignedCoordinatorSession };
}

export async function verifyCoordinatorEnvelope(session: SignedCoordinatorSession, value: unknown, now = Date.now()): Promise<{ ok: true; frame: SignedCoordinatorEnvelope } | { ok: false; error: string }> {
  if (!value || typeof value !== "object") return { ok: false, error: "frame must be an object" };
  const frame = value as Partial<SignedCoordinatorEnvelope>;
  const invalid = validateCoordinatorEnvelope(frame);
  if (invalid) return { ok: false, error: invalid };
  if (frame.sessionId !== session.descriptor.sessionId || session.descriptor.expiresAt <= now) return { ok: false, error: "session is unknown or expired" };
  if (Math.abs(now - frame.createdAt!) > COORDINATOR_CLOCK_SKEW_MS) return { ok: false, error: "frame is outside the accepted time window" };
  const sender = session.descriptor.members.find((member) => member.ownerId === frame.fromOwner);
  if (!sender || !session.descriptor.members.some((member) => member.ownerId === frame.toOwner)) return { ok: false, error: "owner is not a member of this session" };
  if (typeof frame.signature !== "string" || !(await verifyEd25519(sender, coordinatorEnvelopeBytes(frame as SignedCoordinatorEnvelope), frame.signature))) return { ok: false, error: "frame signature is invalid" };
  return { ok: true, frame: frame as SignedCoordinatorEnvelope };
}

export async function verifyCoordinatorPoll(session: SignedCoordinatorSession, value: unknown, now = Date.now()): Promise<{ ok: true; request: CoordinatorPollRequest } | { ok: false; error: string }> {
  if (!value || typeof value !== "object") return { ok: false, error: "poll request must be an object" };
  const request = value as Partial<CoordinatorPollRequest>;
  if (request.version !== 1 || request.sessionId !== session.descriptor.sessionId || typeof request.ownerId !== "string" || !Number.isSafeInteger(request.createdAt) || typeof request.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce) || typeof request.signature !== "string") return { ok: false, error: "invalid poll request" };
  if (session.descriptor.expiresAt <= now) return { ok: false, error: "session is unknown or expired" };
  if (Math.abs(now - request.createdAt!) > COORDINATOR_CLOCK_SKEW_MS) return { ok: false, error: "poll request is outside the accepted time window" };
  const member = session.descriptor.members.find((owner) => owner.ownerId === request.ownerId);
  if (!member || !(await verifyEd25519(member, coordinatorPollBytes(request as Omit<CoordinatorPollRequest, "signature">), request.signature))) return { ok: false, error: "poll signature is invalid" };
  return { ok: true, request: request as CoordinatorPollRequest };
}
