import { randomBytes } from "node:crypto";

/**
 * A private owner-local claim used to bind one MCP transport to one provider
 * session. It is deliberately not rendered in a hook card or exposed as a
 * tool argument. The local store remains the authority for the claim.
 */
export interface ConnectionClaim {
  claimId: string;
  handle: string;
  provider: string;
  sessionId: string;
  cwd?: string;
  ownerProcessId?: number;
  issuedAt: string;
  expiresAt: string;
  bindingId?: string;
  boundAt?: string;
}

/** A durable binding survives an MCP worker restart while the provider identity remains active. */
export interface ConnectionBinding {
  bindingId: string;
  claimId: string;
  handle: string;
  provider: string;
  sessionId: string;
  cwd?: string;
  ownerProcessId?: number;
  boundAt: string;
}

export interface ConnectionClaimInput {
  handle: string;
  provider: string;
  sessionId: string;
  cwd?: string;
  ownerProcessId?: number;
  /**
   * A trusted provider SessionStart/UserPromptSubmit continuation. When the
   * provider reuses its parent process across compaction, this permits the
   * hook to carry the existing private binding forward to the new session
   * instead of creating a competing claim. Direct callers remain fail-closed.
   */
  continuation?: boolean;
}

export interface BindConnectionInput {
  provider?: string;
  processId?: number;
}

export const CONNECTION_CLAIM_TTL_MS = 15 * 60_000;
/**
 * A provider-owned process can survive an M9R/provider update without emitting
 * another SessionStart event. Recovery is still fail-closed (one provider,
 * one project, one session, and no revocation), but the session record must
 * outlive the short claim-publication window so an update does not force a
 * fresh provider conversation.
 */
export const PROVIDER_SESSION_RECOVERY_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_CONNECTION_RECORDS = 512;

export function newConnectionId(): string {
  return randomBytes(32).toString("base64url");
}

/** Provider identifiers are adapter names, not user-facing handles. Keep comparison stable for future adapters. */
export function normalizeConnectionProvider(provider: string): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

export function sameConnectionProvider(left: string, right: string): boolean {
  return normalizeConnectionProvider(left) === normalizeConnectionProvider(right);
}

export function validConnectionProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function usableConnectionClaim(
  claim: ConnectionClaim,
  nowMs: number,
  expected?: BindConnectionInput,
): boolean {
  if (!claim || typeof claim !== "object" || !Number.isFinite(nowMs)) return false;
  if (![claim.claimId, claim.handle, claim.provider, claim.sessionId, claim.issuedAt, claim.expiresAt].every((value) => typeof value === "string" && value.length > 0)) return false;
  if (!Number.isFinite(Date.parse(claim.issuedAt)) || !Number.isFinite(Date.parse(claim.expiresAt))) return false;
  if (claim.bindingId !== undefined && typeof claim.bindingId !== "string") return false;
  if (claim.boundAt !== undefined && typeof claim.boundAt !== "string") return false;
  if (claim.cwd !== undefined && typeof claim.cwd !== "string") return false;
  if (claim.ownerProcessId !== undefined && !validConnectionProcessId(claim.ownerProcessId)) return false;
  // Expiry applies only while the claim is waiting to be bound. Once a claim
  // has produced a durable binding, the binding is verified against the
  // active provider identity instead of treating the original bearer claim as
  // a recurring user credential.
  if (claim.bindingId || Date.parse(claim.expiresAt) <= nowMs) return false;
  if (expected?.provider && !sameConnectionProvider(claim.provider, expected.provider)) return false;
  if (expected?.processId !== undefined && claim.ownerProcessId !== undefined && claim.ownerProcessId !== expected.processId) return false;
  return true;
}

