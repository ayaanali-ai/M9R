/**
 * Signs the human Git-authorization attestation itself (Phase B8) — proof
 * the recorded decision was genuinely made by this OathLock deployment and
 * has not been altered, independent of Supabase row integrity. This is
 * NOT the agent commit signer the full plan describes (that key must live
 * in the machine-local Agent Bridge, which is not deployed yet — see
 * services/mission-bridge). Signing the attestation server-side is the
 * piece achievable without that infrastructure, and is what
 * mission-git-provenance.ts's GitAuthorizationAttestation was always
 * missing to match the plan's "signature and key ID" fields.
 *
 * Ed25519 over a canonical JSON encoding (sorted keys, no whitespace) so the
 * same logical payload always signs identically. Fail-closed: signing
 * throws rather than silently skipping when no key is configured, the same
 * discipline mission-worker/mission-relay use for their own required env
 * vars.
 */

import { sign, verify, createPrivateKey, createPublicKey, createHash, type KeyObject } from "node:crypto";

export const ATTESTATION_VERSION = "oathlock.git-authorization-attestation-signature.v1";

function canonicalize(payload: Record<string, unknown>): Buffer {
  const sorted = Object.keys(payload).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = payload[key];
    return acc;
  }, {});
  return Buffer.from(JSON.stringify(sorted));
}

function loadPrivateKey(): KeyObject {
  const raw = process.env.MISSION_GIT_ATTESTATION_SIGNING_KEY?.trim();
  if (!raw) throw new Error("MISSION_GIT_ATTESTATION_SIGNING_KEY is required to sign a Git authorization attestation.");
  try {
    return createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("MISSION_GIT_ATTESTATION_SIGNING_KEY is not a valid base64-encoded PKCS8 Ed25519 private key.");
  }
}

/** Derived from the public key, not secret — safe to store/display alongside the signature so a verifier knows which key to check against. */
export function attestationKeyId(): string {
  const privateKey = loadPrivateKey();
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export interface SignedAttestation {
  version: typeof ATTESTATION_VERSION;
  signature: string;
  keyId: string;
}

export function signAttestationPayload(payload: Record<string, unknown>): SignedAttestation {
  const privateKey = loadPrivateKey();
  const signature = sign(null, canonicalize(payload), privateKey).toString("base64");
  return { version: ATTESTATION_VERSION, signature, keyId: attestationKeyId() };
}

/** Verification never throws — a bad/missing signature is a fact to report, not an exception to catch elsewhere. */
export function verifyAttestationPayload(payload: Record<string, unknown>, signed: SignedAttestation): boolean {
  try {
    const privateKey = loadPrivateKey();
    const publicKey = createPublicKey(privateKey);
    if (signed.keyId !== attestationKeyId()) return false;
    return verify(null, canonicalize(payload), publicKey, Buffer.from(signed.signature, "base64"));
  } catch {
    return false;
  }
}
