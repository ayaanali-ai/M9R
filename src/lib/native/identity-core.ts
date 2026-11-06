/**
 * P1 identity (design: M9R_IDENTITY_AND_CONTROL_DESIGN.md section 4). Every agent session gets an internal,
 * random credential when it starts. M9R resolves the exact owner-managed session at the MCP boundary; the credential
 * remains inside M9R and is used only when a lower-level adapter still needs token-shaped authorization.
 *
 * Honest limit: the credential lives in the same local store as everything else in `~/.m9r`, readable by anything
 * running as the same Windows user. It is an internal session-binding mechanism, not a user-facing setup secret.
 */
import { randomBytes } from "node:crypto";

export interface IdentityToken {
  token: string;
  handle: string;
  provider: string;
  sessionId: string;
  issuedAt: string;
  /** Set once the token is revoked (session ended, or the person removed it from the pill); a revoked token verifies as invalid. */
  revokedAt?: string;
}

/** 192 bits, base64url: short enough to sit in a hook's context line, long enough that guessing it is not a real attack. */
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function issueIdentity(handle: string, provider: string, sessionId: string, now: string): IdentityToken {
  return { token: newToken(), handle, provider, sessionId, issuedAt: now };
}

export interface VerifiedIdentity {
  handle: string;
  provider: string;
  sessionId: string;
}

/** A token verifies only while it exists, is not revoked, and (loosely) belongs to the session presenting it, if one is given. */
export function verifyToken(tokens: readonly IdentityToken[], presented: string, claimedSessionId?: string): VerifiedIdentity | null {
  const hit = tokens.find((t) => t.token === presented && !t.revokedAt);
  if (!hit) return null;
  if (claimedSessionId && claimedSessionId !== hit.sessionId) return null;
  return { handle: hit.handle, provider: hit.provider, sessionId: hit.sessionId };
}
