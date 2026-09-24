import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";
import { validateCoordinatorEnvelope, type CoordinatorEnvelope, type CoordinatorMessageKind } from "./web-coordinator-core";
import {
  coordinatorEnvelopeBytes,
  coordinatorPollBytes,
  coordinatorSessionBytes,
  type CoordinatorMember,
  type CoordinatorPollRequest,
  type CoordinatorSessionAcceptance,
  type CoordinatorSessionDescriptor,
  type SignedCoordinatorEnvelope,
  type SignedCoordinatorSession,
} from "./web-coordinator-protocol";

const MAX_CLOCK_SKEW_MS = 90_000;

export interface CoordinatorIdentity {
  member: CoordinatorMember;
  signingPrivateKey: string;
  encryptionPrivateKey: string;
}

export function createCoordinatorIdentity(): CoordinatorIdentity {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const signingPublicKey = signing.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const encryptionPublicKey = encryption.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const ownerId = createHash("sha256").update(Buffer.from(signingPublicKey, "base64url")).digest("base64url");
  return {
    member: { ownerId, signingPublicKey, encryptionPublicKey },
    signingPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    encryptionPrivateKey: encryption.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

export function createCoordinatorSessionDescriptor(sessionId: string, members: readonly CoordinatorMember[], createdAt: number, expiresAt: number): CoordinatorSessionDescriptor {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || members.length !== 2 || members[0].ownerId === members[1].ownerId) throw new Error("session requires a valid ID and two distinct owners");
  const sorted = [...members].sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return { version: 1, sessionId, createdAt, expiresAt, members: sorted as [CoordinatorMember, CoordinatorMember] };
}

export function signCoordinatorSession(identity: CoordinatorIdentity, descriptor: CoordinatorSessionDescriptor): CoordinatorSessionAcceptance {
  if (!descriptor.members.some((member) => member.ownerId === identity.member.ownerId)) throw new Error("identity is not a member of the proposed session");
  const privateKey = createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, "base64url"), type: "pkcs8", format: "der" });
  return { ownerId: identity.member.ownerId, signature: sign(null, Buffer.from(coordinatorSessionBytes(descriptor)), privateKey).toString("base64url") };
}

export function assembleCoordinatorSession(descriptor: CoordinatorSessionDescriptor, acceptances: CoordinatorSessionAcceptance[]): SignedCoordinatorSession {
  return { descriptor, acceptances: [...acceptances].sort((a, b) => a.ownerId.localeCompare(b.ownerId)) };
}

function verifyNodeSignature(member: CoordinatorMember, bytes: Uint8Array, signature: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(member.signingPublicKey, "base64url"), type: "spki", format: "der" });
    return verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, "base64url"));
  } catch { return false; }
}

export function verifyCoordinatorSessionLocal(value: unknown, now = Date.now()): { ok: true; session: SignedCoordinatorSession } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "session registration must be an object" };
  const session = value as Partial<SignedCoordinatorSession>;
  const descriptor = session.descriptor;
  if (!descriptor || descriptor.version !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.sessionId) || descriptor.expiresAt <= now || descriptor.expiresAt - descriptor.createdAt > 24 * 60 * 60 * 1_000 || descriptor.createdAt > now + MAX_CLOCK_SKEW_MS) return { ok: false, error: "session descriptor is invalid or expired" };
  if (descriptor.members.length !== 2 || descriptor.members[0].ownerId === descriptor.members[1].ownerId) return { ok: false, error: "session needs two distinct members" };
  const members = new Map(descriptor.members.map((member) => [member.ownerId, member]));
  if (!Array.isArray(session.acceptances) || session.acceptances.length !== 2) return { ok: false, error: "both owners must sign the session descriptor" };
  const acceptedOwners = new Set<string>();
  for (const acceptance of session.acceptances) {
    const member = members.get(acceptance.ownerId);
    const fingerprint = createHash("sha256").update(Buffer.from(member?.signingPublicKey ?? "", "base64url")).digest("base64url");
    if (!member || acceptedOwners.has(acceptance.ownerId) || fingerprint !== member.ownerId || !verifyNodeSignature(member, coordinatorSessionBytes(descriptor), acceptance.signature)) return { ok: false, error: "a required owner signature is missing or invalid" };
    acceptedOwners.add(acceptance.ownerId);
  }
  if (acceptedOwners.size !== members.size) return { ok: false, error: "both owners must sign the session descriptor" };
  return { ok: true, session: session as SignedCoordinatorSession };
}

export function verifyCoordinatorEnvelopeLocal(session: SignedCoordinatorSession, value: unknown, now = Date.now()): { ok: true; frame: SignedCoordinatorEnvelope } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "frame must be an object" };
  const frame = value as Partial<SignedCoordinatorEnvelope>;
  const invalid = validateCoordinatorEnvelope(frame);
  if (invalid) return { ok: false, error: invalid };
  if (frame.sessionId !== session.descriptor.sessionId || session.descriptor.expiresAt <= now || Math.abs(now - frame.createdAt!) > MAX_CLOCK_SKEW_MS) return { ok: false, error: "frame is expired or outside the accepted time window" };
  const sender = session.descriptor.members.find((member) => member.ownerId === frame.fromOwner);
  if (!sender || !session.descriptor.members.some((member) => member.ownerId === frame.toOwner) || typeof frame.signature !== "string" || !verifyNodeSignature(sender, coordinatorEnvelopeBytes(frame as SignedCoordinatorEnvelope), frame.signature)) return { ok: false, error: "frame signature or membership is invalid" };
  return { ok: true, frame: frame as SignedCoordinatorEnvelope };
}

export function verifyCoordinatorPollLocal(session: SignedCoordinatorSession, value: CoordinatorPollRequest, now = Date.now()): boolean {
  if (value.version !== 1 || value.sessionId !== session.descriptor.sessionId || session.descriptor.expiresAt <= now || Math.abs(now - value.createdAt) > MAX_CLOCK_SKEW_MS || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce)) return false;
  const member = session.descriptor.members.find((item) => item.ownerId === value.ownerId);
  return Boolean(member && verifyNodeSignature(member, coordinatorPollBytes(value), value.signature));
}

function coordinatorEnvelopeAad(frame: Omit<CoordinatorEnvelope, "sealedPayload">): Buffer {
  return Buffer.from(JSON.stringify({
    version: frame.version,
    sessionId: frame.sessionId,
    fromOwner: frame.fromOwner,
    toOwner: frame.toOwner,
    sequence: frame.sequence,
    nonce: frame.nonce,
    createdAt: frame.createdAt,
    kind: frame.kind,
  }));
}

function sharedSessionKey(identity: CoordinatorIdentity, peer: CoordinatorMember, sessionId: string): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.from(identity.encryptionPrivateKey, "base64url"), type: "pkcs8", format: "der" });
  const publicKey = createPublicKey({ key: Buffer.from(peer.encryptionPublicKey, "base64url"), type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId), Buffer.from("M9R web coordinator E2E payload v1"), 32));
}

export function createSealedCoordinatorEnvelope(
  identity: CoordinatorIdentity,
  recipient: CoordinatorMember,
  session: CoordinatorSessionDescriptor,
  kind: CoordinatorMessageKind,
  sequence: number,
  payload: unknown,
  now = Date.now(),
): SignedCoordinatorEnvelope {
  const sender = session.members.find((member) => member.ownerId === identity.member.ownerId);
  if (!sender || !session.members.some((member) => member.ownerId === recipient.ownerId) || recipient.ownerId === sender.ownerId) throw new Error("sender and recipient must be distinct members of the session");
  if (!Number.isSafeInteger(sequence) || sequence < 1 || session.expiresAt <= now) throw new Error("invalid sequence or expired session");
  const header = {
    version: 1 as const,
    sessionId: session.sessionId,
    fromOwner: sender.ownerId,
    toOwner: recipient.ownerId,
    sequence,
    nonce: randomBytes(24).toString("base64url"),
    createdAt: now,
    kind,
  };
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (plaintext.length < 1 || plaintext.length > 48 * 1024) throw new Error("payload must be non-empty and at most 48 KiB before sealing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sharedSessionKey(identity, recipient, session.sessionId), iv);
  cipher.setAAD(coordinatorEnvelopeAad(header));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealedPayload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  const unsigned = { ...header, sealedPayload };
  const signingKey = createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, "base64url"), type: "pkcs8", format: "der" });
  const signature = sign(null, Buffer.from(coordinatorEnvelopeBytes(unsigned)), signingKey).toString("base64url");
  return { ...unsigned, signature };
}

export function openSealedCoordinatorEnvelope(
  identity: CoordinatorIdentity,
  sender: CoordinatorMember,
  session: CoordinatorSessionDescriptor,
  frame: SignedCoordinatorEnvelope,
): unknown {
  if (frame.sessionId !== session.sessionId || frame.toOwner !== identity.member.ownerId || frame.fromOwner !== sender.ownerId || !session.members.some((member) => member.ownerId === identity.member.ownerId)) throw new Error("frame is not addressed to this session member");
  const publicKey = createPublicKey({ key: Buffer.from(sender.signingPublicKey, "base64url"), type: "spki", format: "der" });
  if (!verify(null, Buffer.from(coordinatorEnvelopeBytes(frame)), publicKey, Buffer.from(frame.signature, "base64url"))) throw new Error("frame signature is invalid");
  const packed = Buffer.from(frame.sealedPayload, "base64url");
  if (packed.length < 29) throw new Error("sealed payload is truncated");
  const header = {
    version: frame.version,
    sessionId: frame.sessionId,
    fromOwner: frame.fromOwner,
    toOwner: frame.toOwner,
    sequence: frame.sequence,
    nonce: frame.nonce,
    createdAt: frame.createdAt,
    kind: frame.kind,
  };
  const decipher = createDecipheriv("aes-256-gcm", sharedSessionKey(identity, sender, session.sessionId), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  decipher.setAAD(coordinatorEnvelopeAad(header));
  const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

export interface CoordinatorClientOptions {
  endpoint: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createCoordinatorNodeClient(identity: CoordinatorIdentity, options: CoordinatorClientOptions) {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetcher(`${endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `coordinator returned HTTP ${response.status}`);
    return result;
  }

  return {
    async registerSession(session: SignedCoordinatorSession) {
      const verified = verifyCoordinatorSessionLocal(session, now());
      if (!verified.ok) throw new Error(verified.error);
      return post<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(session.descriptor.sessionId)}/register`, session);
    },
    async send(session: SignedCoordinatorSession, recipientId: string, payload: unknown, input: { sequence: number; kind: CoordinatorMessageKind; now?: () => number }) {
      const recipient = session.descriptor.members.find((member) => member.ownerId === recipientId);
      if (!recipient) throw new Error("recipient is not a member of the session");
      const frame = createSealedCoordinatorEnvelope(identity, recipient, session.descriptor, input.kind, input.sequence, payload, input.now?.() ?? now());
      const ack = await post<{ ok: boolean; accepted: boolean }>(`/v1/sessions/${encodeURIComponent(session.descriptor.sessionId)}/frames`, frame);
      return { ...ack, frame };
    },
    async receive(session: SignedCoordinatorSession, input: { now?: () => number } = {}) {
      const createdAt = input.now?.() ?? now();
      const pollBody = { version: 1 as const, sessionId: session.descriptor.sessionId, ownerId: identity.member.ownerId, createdAt, nonce: randomBytes(24).toString("base64url") };
      const key = createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, "base64url"), type: "pkcs8", format: "der" });
      const poll: CoordinatorPollRequest = { ...pollBody, signature: sign(null, Buffer.from(coordinatorPollBytes(pollBody)), key).toString("base64url") };
      const response = await post<{ frames: SignedCoordinatorEnvelope[] }>(`/v1/sessions/${encodeURIComponent(session.descriptor.sessionId)}/poll`, poll);
      const opened: Array<{ frame: SignedCoordinatorEnvelope; payload: unknown }> = [];
      for (const frame of response.frames) {
        const valid = verifyCoordinatorEnvelopeLocal(session, frame, createdAt);
        if (!valid.ok) throw new Error(`received an invalid coordinator frame: ${valid.error}`);
        const sender = session.descriptor.members.find((member) => member.ownerId === frame.fromOwner);
        if (!sender) throw new Error("received a frame from an unknown session member");
        opened.push({ frame, payload: openSealedCoordinatorEnvelope(identity, sender, session.descriptor, frame) });
      }
      return opened;
    },
  };
}
