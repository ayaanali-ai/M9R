/**
 * Agent Join Service (OathLock Agent Join v0)
 * ----------------------------------------------------------------------------
 * DB-facing operations for the agent-native layer. Two trust paths:
 *
 *  - Agent (token-authenticated) routes use the SERVICE-ROLE client and
 *    authorize by token hash in app code. They never trust a client-supplied
 *    workspace id — the workspace is whatever the token's connection is bound to.
 *
 *  - The human approval path uses the COOKIE client to identify the signed-in
 *    user, resolves a workspace THEY own (reusing projects-service), and only
 *    then provisions the connection + token via the service-role client.
 *
 * Invariants:
 *  - No human approval → no connection/token (approveClaim is the only creator).
 *  - The durable token store keeps only token_hash. The raw token is held
 *    transiently on the claim row between approval and first retrieval, then
 *    nulled — see docs/proof/agent-join-v0.md for why and the limitation.
 *  - Raw session text is never persisted here (only honest metadata).
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { assertCanConnectAgent } from "@/lib/plan-limits-service";
import {
  type RegisterInput,
  type AgentKind,
  DEFAULT_AGENT_SCOPES,
  generateAgentToken,
  generateSetupCode,
  hashSecret,
  sanitizeString,
  buildClaimUrl,
  claimExpiry,
  isExpired,
} from "@/lib/agent-join";
import type { RuleEffectivenessDecision } from "@/lib/rule-effectiveness";

export class AgentJoinError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "AgentJoinError";
    this.code = code;
    this.status = status;
  }
}

function requireService() {
  if (!supabase) {
    throw new AgentJoinError(
      "M9R agent backend is not configured.",
      "DB_NOT_CONFIGURED",
      503,
    );
  }
  return supabase;
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterResult {
  claim_url: string;
  claim_id: string;
  setup_code: string;
  expires_at: string;
}

/** Create a pending claim. Returns the one-time setup_code (raw) to the agent. */
export async function registerClaim(input: RegisterInput, baseUrl: string): Promise<RegisterResult> {
  const db = requireService();
  const setupCode = generateSetupCode();
  const expiresAt = claimExpiry();

  const { data, error } = await db
    .from("agent_claims")
    .insert({
      setup_code_hash: hashSecret(setupCode),
      agent_kind: input.agentKind,
      repo_hint: input.repoHint,
      rule_targets: input.ruleTargets,
      capabilities: input.capabilities,
      consent_mode: input.consentMode,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("registerClaim insert failed:", error?.message, error?.code);
    throw new AgentJoinError("Could not create a claim.", "REGISTER_FAILED", 500);
  }

  return {
    claim_url: buildClaimUrl(baseUrl, data.id as string),
    claim_id: data.id as string,
    setup_code: setupCode,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Claim — public read (for the human approval page; no secrets)
// ---------------------------------------------------------------------------

export interface ClaimPublicView {
  claim_id: string;
  agent_kind: AgentKind;
  repo_hint: string;
  rule_targets: string[];
  capabilities: string[];
  requested_scopes: string[];
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: string;
  expired: boolean;
}

/** Safe subset for the human claim page. Never returns setup_code or token. */
export async function getClaimPublic(claimId: string): Promise<ClaimPublicView | null> {
  const db = requireService();
  const { data, error } = await db
    .from("agent_claims")
    .select("id, agent_kind, repo_hint, rule_targets, capabilities, status, expires_at")
    .eq("id", claimId)
    .maybeSingle();

  if (error) {
    console.error("getClaimPublic failed:", error.message, error.code);
    return null;
  }
  if (!data) return null;

  const expired = isExpired(data.expires_at as string);
  const status = (expired && data.status === "pending" ? "expired" : data.status) as ClaimPublicView["status"];

  return {
    claim_id: data.id as string,
    agent_kind: data.agent_kind as AgentKind,
    repo_hint: data.repo_hint as string,
    rule_targets: (data.rule_targets as string[]) ?? [],
    capabilities: (data.capabilities as string[]) ?? [],
    requested_scopes: [...DEFAULT_AGENT_SCOPES],
    status,
    expires_at: data.expires_at as string,
    expired,
  };
}

// ---------------------------------------------------------------------------
// Approve / reject (human, cookie-authenticated)
// ---------------------------------------------------------------------------

export interface ApproveResult {
  status: "approved";
  workspace_id: string;
  connection_id: string;
}

/**
 * Approve a claim as the signed-in human. Binds the connection to a workspace
 * the user owns, provisions a scoped token (hash stored; raw held transiently
 * on the claim for one-time agent retrieval), and marks the claim approved.
 */
export async function approveClaim(claimId: string): Promise<ApproveResult> {
  const cookieDb = await createClient();
  if (!cookieDb) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to approve this connection.", "UNAUTHENTICATED", 401);

  const workspaceId = await resolveActiveOrDefaultProjectId(cookieDb, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });

  const db = requireService();

  // Plan enforcement happens BEFORE the atomic approval RPC -- a rejected
  // claim must never provision a token or bind a connection.
  const { data: pendingClaim } = await db.from("agent_claims").select("agent_kind").eq("id", claimId).maybeSingle();
  if (pendingClaim?.agent_kind) {
    await assertCanConnectAgent(db, user.id, workspaceId, pendingClaim.agent_kind as string);
  }

  const now = new Date().toISOString();
  const rawToken = generateAgentToken();
  const { data, error } = await db.rpc("approve_agent_claim_atomic", {
    p_claim_id: claimId,
    p_user_id: user.id,
    p_workspace_id: workspaceId,
    p_token_hash: hashSecret(rawToken),
    p_one_time_token: rawToken,
    p_scopes: [...DEFAULT_AGENT_SCOPES],
    p_approved_at: now,
  });
  const result = Array.isArray(data)
    ? data[0] as {
        accepted?: boolean;
        reason?: string | null;
        claim_status?: string | null;
        approved_workspace_id?: string | null;
        approved_connection_id?: string | null;
      } | undefined
    : undefined;

  if (error) {
    console.error("approveClaim atomic RPC failed:", error.message, error.code);
    throw new AgentJoinError("Could not approve the connection.", "APPROVE_FAILED", 500);
  }
  if (!result?.accepted) {
    if (result?.reason === "not_found") {
      throw new AgentJoinError("Claim not found.", "NOT_FOUND", 404);
    }
    if (result?.reason === "expired") {
      throw new AgentJoinError("This claim has expired. Ask the agent to request a new one.", "EXPIRED", 410);
    }
    if (result?.reason === "already_resolved") {
      throw new AgentJoinError(`Claim is already ${result.claim_status ?? "resolved"}.`, "BAD_STATE", 409);
    }
    throw new AgentJoinError("Could not approve the connection.", "APPROVE_FAILED", 500);
  }
  if (!result.approved_workspace_id || !result.approved_connection_id) {
    throw new AgentJoinError("Could not approve the connection.", "APPROVE_FAILED", 500);
  }

  return {
    status: "approved",
    workspace_id: result.approved_workspace_id,
    connection_id: result.approved_connection_id,
  };
}

/** Reject a claim as the signed-in human. */
export async function rejectClaim(claimId: string): Promise<{ status: "rejected" }> {
  const cookieDb = await createClient();
  if (!cookieDb) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to reject this connection.", "UNAUTHENTICATED", 401);

  const db = requireService();
  const { data: claim } = await db.from("agent_claims").select("status").eq("id", claimId).maybeSingle();
  if (!claim) throw new AgentJoinError("Claim not found.", "NOT_FOUND", 404);
  if (claim.status !== "pending") {
    throw new AgentJoinError(`Claim is already ${claim.status}.`, "BAD_STATE", 409);
  }
  const { data, error } = await db
    .from("agent_claims")
    .update({ status: "rejected", rejected_at: new Date().toISOString() })
    .eq("id", claimId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw new AgentJoinError("Could not reject this claim.", "REJECT_FAILED", 500);
  if (!data) throw new AgentJoinError("Claim is already resolved.", "BAD_STATE", 409);
  return { status: "rejected" };
}

// ---------------------------------------------------------------------------
// Claim status (agent, setup_code-authenticated)
// ---------------------------------------------------------------------------

export type ClaimStatusResult =
  | { status: "pending" }
  | { status: "rejected" }
  | { status: "expired" }
  | { status: "approved"; token?: string; scopes?: string[]; token_already_retrieved?: boolean };

/**
 * Poll claim status. Requires the correct setup_code (claim_id alone is not
 * enough). Returns the raw token exactly once on the first poll after approval;
 * subsequent polls report approved without the token.
 */
export async function pollClaimStatus(claimId: string, setupCode: string): Promise<ClaimStatusResult> {
  const db = requireService();
  const { data, error } = await db.rpc("consume_agent_claim_token_atomic", {
    p_claim_id: claimId,
    p_setup_code_hash: hashSecret(setupCode),
    p_retrieved_at: new Date().toISOString(),
  });

  if (error) {
    console.error("pollClaimStatus failed:", error.message, error.code);
    throw new AgentJoinError("Could not read claim status.", "STATUS_FAILED", 500);
  }
  const result = Array.isArray(data)
    ? data[0] as {
        accepted?: boolean;
        reason?: string | null;
        claim_status?: string | null;
        one_time_token?: string | null;
      } | undefined
    : undefined;
  if (!result) throw new AgentJoinError("Could not read claim status.", "STATUS_FAILED", 500);
  if (!result.accepted && result.reason === "not_found") {
    throw new AgentJoinError("Claim not found.", "NOT_FOUND", 404);
  }
  if (!result.accepted && result.reason === "bad_setup_code") {
    throw new AgentJoinError("Invalid setup_code for this claim.", "BAD_SETUP_CODE", 403);
  }
  if (!result.accepted) throw new AgentJoinError("Could not read claim status.", "STATUS_FAILED", 500);

  if (result.claim_status === "rejected") return { status: "rejected" };
  if (result.claim_status === "pending") return { status: "pending" };
  if (result.claim_status === "expired") return { status: "expired" };
  if (result.claim_status !== "approved") {
    throw new AgentJoinError("Could not read claim status.", "STATUS_FAILED", 500);
  }
  if (result.one_time_token) {
    return { status: "approved", token: result.one_time_token, scopes: [...DEFAULT_AGENT_SCOPES] };
  }
  return { status: "approved", token_already_retrieved: true };
}

// ---------------------------------------------------------------------------
// Token authentication (agent, Bearer)
// ---------------------------------------------------------------------------

export interface AuthedAgent {
  connectionId: string;
  workspaceId: string;
  agentKind: AgentKind;
  scopes: string[];
  repoHint: string | null;
  /** The agent_tokens row id this request authenticated with — needed to revoke exactly this token on rotation, never a different one. Null for dashboard-initiated (cookie-authenticated) synthetic agent contexts that never had a bearer token to begin with. */
  tokenId: string | null;
}

export interface DisconnectAgentConnectionResult {
  ok: true;
  connection_id: string;
  status: "revoked";
  already_disconnected: boolean;
  tokens_revoked: number;
}

async function revokeAgentConnection(
  connectionId: string,
  alreadyDisconnected: boolean,
): Promise<DisconnectAgentConnectionResult> {
  const now = new Date().toISOString();
  const db = requireService();

  if (!alreadyDisconnected) {
    const { error: connectionError } = await db
      .from("agent_connections")
      .update({ status: "revoked", revoked_at: now })
      .eq("id", connectionId);
    if (connectionError) {
      console.error("disconnectAgentConnection connection update failed:", connectionError.message, connectionError.code);
      throw new AgentJoinError("Could not disconnect this agent.", "DISCONNECT_FAILED", 500);
    }
  }

  const { data: revokedTokens, error: tokenError } = await db
    .from("agent_tokens")
    .update({ revoked_at: now })
    .eq("connection_id", connectionId)
    .select("id");
  if (tokenError) {
    console.error("disconnectAgentConnection token update failed:", tokenError.message, tokenError.code);
    throw new AgentJoinError("Agent was disconnected, but token revocation could not be confirmed.", "TOKEN_REVOKE_FAILED", 500);
  }

  return {
    ok: true,
    connection_id: connectionId,
    status: "revoked",
    already_disconnected: alreadyDisconnected,
    tokens_revoked: revokedTokens?.length ?? 0,
  };
}

/**
 * Disconnect a coding agent from the dashboard. This is a server-side
 * revocation: the connection stops being active and all tokens for that
 * connection are marked revoked. Historical runs/sessions/review records remain.
 */
export async function disconnectAgentConnection(rawConnectionId: string): Promise<DisconnectAgentConnectionResult> {
  const connectionId = sanitizeString(rawConnectionId, 80);
  if (!connectionId) {
    throw new AgentJoinError("Connection id is required.", "BAD_REQUEST", 400);
  }

  const cookieDb = await createClient();
  if (!cookieDb) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to disconnect this agent.", "UNAUTHENTICATED", 401);

  const { data: connection, error: lookupError } = await cookieDb
    .from("agent_connections")
    .select("id, workspace_id, status")
    .eq("id", connectionId)
    .maybeSingle();

  if (lookupError) {
    console.error("disconnectAgentConnection lookup failed:", lookupError.message, lookupError.code);
    throw new AgentJoinError("Could not resolve agent connection.", "CONNECTION_LOOKUP_FAILED", 500);
  }
  if (!connection) {
    throw new AgentJoinError("Agent connection was not found.", "NOT_FOUND", 404);
  }

  return revokeAgentConnection(connectionId, connection.status === "revoked");
}

export interface DashboardConnectionSummary {
  connectionId: string;
  agentKind: string;
  repoHint: string | null;
  lastSeenAt: string | null;
}

/**
 * List this human's active agent connections for Settings' "Connected
 * agents" section. Cookie-authenticated; RLS on `agent_connections` is the
 * ownership proof, same as disconnectAgentConnection above -- no explicit
 * workspace filter needed because the cookie client can only see rows RLS
 * already scopes to the signed-in user.
 */
export async function listConnectedAgentsForDashboard(): Promise<DashboardConnectionSummary[]> {
  const cookieDb = await createClient();
  if (!cookieDb) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to view connected agents.", "UNAUTHENTICATED", 401);

  const { data, error } = await cookieDb
    .from("agent_connections")
    .select("id, agent_kind, repo_hint, last_seen_at")
    .eq("status", "active")
    .eq("created_by", user.id)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false, nullsFirst: false });
  if (error) {
    console.error("listConnectedAgentsForDashboard failed:", error.message, error.code);
    throw new AgentJoinError("Could not list connected agents.", "CONNECTIONS_LIST_FAILED", 500);
  }

  return (data ?? []).map((row) => ({
    connectionId: row.id as string,
    agentKind: row.agent_kind as string,
    repoHint: (row.repo_hint as string | null) ?? null,
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
  }));
}

const MAX_MODEL_LENGTH = 80;

/**
 * Set (or clear) the model override for one connected agent. Cookie-
 * authenticated only -- this is a human dashboard action, same guardrail
 * shape as disconnectAgentConnection. The RLS-scoped SELECT below is the
 * actual ownership proof: a non-owner's lookup returns null regardless of
 * what connectionId they pass, before any write is attempted.
 */
export async function setAgentConnectionModel(rawConnectionId: string, rawModel: string | null): Promise<{ ok: true; connectionId: string; model: string | null }> {
  const connectionId = sanitizeString(rawConnectionId, 80);
  if (!connectionId) throw new AgentJoinError("Connection id is required.", "BAD_REQUEST", 400);
  const model = rawModel === null ? null : sanitizeString(rawModel, MAX_MODEL_LENGTH);
  if (rawModel !== null && !model) throw new AgentJoinError("Model must be a non-empty string, or null to clear it.", "BAD_REQUEST", 400);

  const cookieDb = await createClient();
  if (!cookieDb) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to change this agent's model.", "UNAUTHENTICATED", 401);

  const { data: connection, error: lookupError } = await cookieDb
    .from("agent_connections")
    .select("id, agent_kind")
    .eq("id", connectionId)
    .maybeSingle();
  if (lookupError) {
    console.error("setAgentConnectionModel lookup failed:", lookupError.message, lookupError.code);
    throw new AgentJoinError("Could not resolve agent connection.", "CONNECTION_LOOKUP_FAILED", 500);
  }
  if (!connection) throw new AgentJoinError("Agent connection was not found.", "NOT_FOUND", 404);

  const db = requireService();
  const { error: updateError } = await db.from("agent_connections").update({ model }).eq("id", connectionId);
  if (updateError) {
    console.error("setAgentConnectionModel update failed:", updateError.message, updateError.code);
    throw new AgentJoinError("Could not save the model override.", "MODEL_UPDATE_FAILED", 500);
  }

  return { ok: true, connectionId, model };
}

/** Disconnect the current Bearer-token connection from the CLI. */
export async function disconnectAuthenticatedAgent(agent: AuthedAgent): Promise<DisconnectAgentConnectionResult> {
  const connectionId = sanitizeString(agent.connectionId, 80);
  if (!connectionId) {
    throw new AgentJoinError("Connection id is required.", "BAD_REQUEST", 400);
  }
  return revokeAgentConnection(connectionId, false);
}

/** Extract a Bearer token from an Authorization header value. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Authenticate an agent by its Bearer token. Looks up by hash, checks the
 * connection is active and the token is not revoked/expired, bumps last_used_at,
 * and returns the bound workspace + scopes. Returns null when unauthenticated.
 */
export async function authenticateAgent(rawToken: string | null): Promise<AuthedAgent | null> {
  if (!rawToken) return null;
  const db = requireService();
  const { data, error } = await db
    .from("agent_tokens")
    .select("id, connection_id, workspace_id, scopes, expires_at, revoked_at")
    .eq("token_hash", hashSecret(rawToken))
    .maybeSingle();

  if (error) {
    console.error("authenticateAgent failed:", error.message, error.code);
    return null;
  }
  if (!data) return null;
  if (data.revoked_at) return null;
  if (data.expires_at && isExpired(data.expires_at as string)) return null;

  // Connection must still be active.
  const { data: conn } = await db
    .from("agent_connections")
    .select("status, agent_kind, repo_hint")
    .eq("id", data.connection_id)
    .maybeSingle();
  if (!conn || conn.status !== "active") return null;

  const now = new Date().toISOString();
  await db.from("agent_tokens").update({ last_used_at: now }).eq("id", data.id);
  await db.from("agent_connections").update({ last_seen_at: now }).eq("id", data.connection_id);

  return {
    connectionId: data.connection_id as string,
    workspaceId: data.workspace_id as string,
    agentKind: conn.agent_kind as AgentKind,
    scopes: (data.scopes as string[]) ?? [],
    repoHint: (conn.repo_hint as string | null) ?? null,
    tokenId: data.id as string,
  };
}

/**
 * Rotate the calling connection's own token: mint a new one with identical
 * scopes, then revoke exactly the token this request authenticated with.
 * Unlike disconnect/reconnect, this never touches connection status or
 * requires a new human-approved claim — the connection identity, presence,
 * and run history are all untouched. There is a brief overlap where both
 * tokens are valid (the new one committed before the old one is revoked), by
 * design: rotation must never leave a window where the connection has NO
 * valid token, which would look like an unexplained disconnect.
 */
export async function rotateAgentToken(agent: AuthedAgent): Promise<{ token: string; scopes: string[] }> {
  if (!agent.tokenId) throw new AgentJoinError("This context has no bearer token to rotate.", "ROTATE_UNSUPPORTED", 400);
  const db = requireService();
  const rawToken = generateAgentToken();

  const { error: insertError } = await db.from("agent_tokens").insert({
    connection_id: agent.connectionId,
    workspace_id: agent.workspaceId,
    token_hash: hashSecret(rawToken),
    scopes: agent.scopes,
  });
  if (insertError) {
    console.error("rotateAgentToken insert failed:", insertError.message, insertError.code);
    throw new AgentJoinError("Could not mint a rotated token.", "ROTATE_FAILED", 500);
  }

  const { error: revokeError } = await db
    .from("agent_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", agent.tokenId)
    .eq("connection_id", agent.connectionId);
  if (revokeError) {
    console.error("rotateAgentToken revoke failed:", revokeError.message, revokeError.code);
    throw new AgentJoinError("New token was issued, but the old token could not be revoked. Disconnect and reconnect if this repeats.", "ROTATE_PARTIAL", 500);
  }

  return { token: rawToken, scopes: agent.scopes };
}

// ---------------------------------------------------------------------------
// Active workspace rules for an agent (slim, machine-readable)
// ---------------------------------------------------------------------------

export interface AgentRule {
  id: string;
  title: string;
  body: string;
  rule_type: string;
  confidence: string;
  evidence_summary: string;
  /** The condition this rule applies under, when a human recorded one --
   * null means no narrower condition was set, not "applies everywhere." */
  scope_condition: string | null;
}

function mapAgentRuleRows(data: Array<Record<string, unknown>>): AgentRule[] {
  return data.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    body: r.body as string,
    rule_type: r.rule_type as string,
    confidence: r.confidence as string,
    evidence_summary: (r.evidence_summary as string) ?? "",
    scope_condition: (r.scope_condition as string | null) ?? null,
  }));
}

async function listActiveRulesForWorkspace(workspaceId: string): Promise<AgentRule[]> {
  const db = requireService();
  const { data, error } = await db
    .from("workspace_rules")
    .select("id, title, body, rule_type, confidence, evidence_summary, scope_condition, status, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("listActiveRulesForAgent failed:", error.message, error.code);
    throw new AgentJoinError("Could not read workspace rules.", "RULES_FAILED", 500);
  }
  return mapAgentRuleRows((data ?? []) as Array<Record<string, unknown>>);
}

/** List ACTIVE evidence-backed rules for the authenticated agent's workspace. */
export async function listActiveRulesForAgent(agent: AuthedAgent): Promise<AgentRule[]> {
  return listActiveRulesForWorkspace(agent.workspaceId);
}

// ---------------------------------------------------------------------------
// Recommended rules from an agent session (needs_review — never auto-active)
// ---------------------------------------------------------------------------

/** Persist conservative Rule Health effects for a bearer-authenticated agent. */
export async function applyRuleEffectivenessForAgent(
  agent: AuthedAgent,
  decision: RuleEffectivenessDecision,
): Promise<void> {
  if (!decision.ruleId || decision.action === "no_change") return;
  const db = requireService();
  const { data: rule } = await db
    .from("workspace_rules")
    .select("id, status, times_helped")
    .eq("id", decision.ruleId)
    .eq("workspace_id", agent.workspaceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!rule) return;
  const now = new Date().toISOString();
  if (decision.action === "increment_helped") {
    await db.from("workspace_rules").update({
      times_helped: ((rule as { times_helped?: number | null }).times_helped ?? 0) + 1,
      updated_at: now,
    }).eq("id", decision.ruleId).eq("workspace_id", agent.workspaceId);
  } else if (decision.action === "mark_needs_review" && (rule as { status?: string }).status === "active") {
    await db.from("workspace_rules").update({ status: "needs_review", retired_at: null, updated_at: now })
      .eq("id", decision.ruleId).eq("workspace_id", agent.workspaceId).eq("status", "active");
  }
}

export interface RecommendedRuleInput {
  title: string;
  body: string;
  ruleType: string;
  confidence: string;
  evidenceSummary: string;
  sourceFindingId: string | null;
  expectedPrevention: string;
}

/**
 * Persist rules generated from an agent session as RECOMMENDED (status
 * needs_review) — never active. A human promotes them in the dashboard, which
 * flips status to active and makes them appear in `npx oathlock rules`. This
 * keeps the human-approval invariant: OathLock never auto-promotes a rule.
 *
 * Provenance is preserved (source session, finding id, evidence summary,
 * rule_type, promoted_at). Deduped by title against existing non-deleted rules.
 * Best-effort; never throws. Returns the number of new recommendations created.
 */
export async function recordRecommendedRulesForAgent(
  agent: AuthedAgent,
  rules: RecommendedRuleInput[],
  sourceSessionName: string,
  sourceSessionId: string | null = null,
): Promise<number> {
  if (rules.length === 0) return 0;
  try {
    const db = requireService();
    const { data: existing } = await db
      .from("workspace_rules")
      .select("title")
      .eq("workspace_id", agent.workspaceId)
      .is("deleted_at", null);
    const seen = new Set(
      ((existing ?? []) as Array<{ title: string }>).map((r) => r.title.trim().toLowerCase()),
    );

    const now = new Date().toISOString();
    const inserts = rules
      .filter((r) => r.title.trim() && !seen.has(r.title.trim().toLowerCase()))
      .map((r) => ({
        workspace_id: agent.workspaceId,
        // Store the source session id so the dashboard can tell run-linked
        // recommendations from legacy/unlinked ones. (TEXT column; safe.)
        source_report_id: sourceSessionId,
        source_session_name: sourceSessionName.slice(0, 200),
        title: r.title,
        body: r.body,
        rule_type: r.ruleType,
        confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
        // Forced needs_review: recommended, awaiting human promotion.
        status: "needs_review",
        evidence_summary: r.evidenceSummary,
        source_finding_id: r.sourceFindingId,
        expected_prevention: r.expectedPrevention,
        last_seen_at: now,
        times_seen: 1,
      }));

    if (inserts.length === 0) return 0;
    const { error } = await db.from("workspace_rules").insert(inserts);
    if (error) {
      console.error("recordRecommendedRulesForAgent insert failed:", error.message, error.code);
      return 0;
    }
    return inserts.length;
  } catch (err) {
    console.error("recordRecommendedRulesForAgent failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Session metadata (no raw content)
// ---------------------------------------------------------------------------

export interface RecordSessionMeta {
  agentKind?: string | null;
  sessionFormat?: string | null;
  sourceQuality?: string | null;
  humanApproved: boolean;
  findingsCount: number;
  rulesGenerated: number;
  summary: string;
  // Derived compare snapshots. Content-free; never raw session text.
  ruleHealth?: unknown | null;
  behavior?: unknown | null;
  /**
   * The real, server-determined three-state classification from
   * evidence-submission.ts (classifySubmission/decideAttachment), recorded
   * alongside the legacy humanApproved boolean above rather than replacing
   * it -- humanApproved keeps gating exactly what it gates today (run
   * completion, rule-health, evidence-contract recording). Optional so any
   * other caller of recordAgentSession that hasn't computed these yet keeps
   * working unchanged.
   */
  submissionOrigin?: "agent" | "human" | "system" | null;
  attachmentStatus?: "draft" | "validated" | "attached" | "rejected" | null;
  humanAttestation?: "not_requested" | "pending" | "attested" | "declined" | null;
  submissionDigest?: string | null;
}

/**
 * Persist honest, non-sensitive session metadata. Best-effort; never throws.
 * Returns the new session row id (or null on failure) so callers can link the
 * session to an agent run.
 */
export async function recordAgentSession(agent: AuthedAgent, meta: RecordSessionMeta): Promise<string | null> {
  try {
    const db = requireService();
    const coreInsert = {
      connection_id: agent.connectionId,
      workspace_id: agent.workspaceId,
      agent_kind: meta.agentKind ?? null,
      session_format: meta.sessionFormat ?? null,
      source_quality: meta.sourceQuality ?? null,
      human_approved_submission: meta.humanApproved,
      findings_count: meta.findingsCount,
      rules_generated: meta.rulesGenerated,
      summary: meta.summary.slice(0, 500),
      submission_origin: meta.submissionOrigin ?? null,
      attachment_status: meta.attachmentStatus ?? null,
      human_attestation: meta.humanAttestation ?? null,
      submission_digest: meta.submissionDigest ?? null,
    };
    const snapshotInsert = {
      ...coreInsert,
      rule_health: meta.ruleHealth ?? null,
      behavior: meta.behavior ?? null,
    };

    let insertResult = await db.from("agent_sessions").insert(snapshotInsert).select("id").single();
    if (insertResult.error && (insertResult.error.code === "42703" || /column .* does not exist/i.test(insertResult.error.message ?? ""))) {
      console.warn("agent_sessions snapshot columns missing; retrying session insert without compare snapshots.");
      insertResult = await db.from("agent_sessions").insert(coreInsert).select("id").single();
    }
    if (insertResult.error) {
      console.error("recordAgentSession insert failed:", insertResult.error.message, insertResult.error.code);
      return null;
    }
    const { data } = insertResult;
    return (data?.id as string) ?? null;
  } catch (err) {
    console.error("recordAgentSession failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
