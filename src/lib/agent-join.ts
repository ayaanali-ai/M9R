/**
 * Agent Join — pure core (OathLock Agent Join v0)
 * ----------------------------------------------------------------------------
 * Dependency-free, IO-free building blocks for the agent-native layer: input
 * validation/sanitization for agent registration, token + setup-code minting
 * and hashing, default scopes, and the honest baseline/operating-guidance
 * payloads the rules endpoint returns.
 *
 * Kept pure so the policy (what's valid, what's secret, what scopes exist, what
 * baseline mode says) is unit-testable without a DB or a network.
 *
 * Non-negotiable claims discipline:
 *  - No human approval → no persistent connection (enforced by the flow).
 *  - No evidence → no workspace behavior rule (the rules endpoint never invents
 *    starter behavior rules; baseline mode is honest about having none yet).
 *  - Tokens are returned to the agent once; only a hash is ever persisted.
 */

import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The kinds with real integration (automatic AGENTS.md/CLAUDE.md bootstrap, a real ACP adapter for @mention-triggered sessions). Not an allowlist for who may connect -- see AGENT_KIND_SLUG_PATTERN below for that. */
export const AGENT_KINDS = ["claude-code", "codex", "grok-build", "opencode", "other"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Any well-formed provider name is a valid connection identity, not just the ones with real integration today -- gatekeeping registration on that list blocked even recording a new tool's identity before any integration work could exist for it. */
export const AGENT_KIND_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A claim is single-use and must be approved within this window. */
export const CLAIM_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Default scopes a freshly-approved agent token receives. Never admin. */
export const DEFAULT_AGENT_SCOPES = [
  "rules:read",
  "session:submit",
  "instructions:read",
  "rule_result:submit",
  "export:generate",
] as const;
export type AgentScope = (typeof DEFAULT_AGENT_SCOPES)[number];

/** Scopes that an agent token must NEVER be granted. */
export const FORBIDDEN_AGENT_SCOPES = [
  "billing",
  "workspace:delete",
  "sessions:read_all",
  "files:upload",
  "admin",
  "workspace:transfer",
] as const;

// Payload size guards (reject oversized / abusive registrations).
export const MAX_REPO_HINT = 200;
export const MAX_STRING_ITEM = 120;
export const MAX_ARRAY_ITEMS = 24;
export const MAX_REGISTER_BYTES = 8 * 1024; // 8 KB is plenty for a registration.

// Control chars (incl. DEL) get collapsed to spaces. Built via RegExp so no
// literal control characters live in this source file.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a free-text string: trim, strip control chars, neutralize anything
 * that looks like active HTML/script, and clamp length. Returns "" for non-
 * strings so callers can treat empty as missing.
 */
export function sanitizeString(value: unknown, maxLen = MAX_STRING_ITEM): string {
  if (typeof value !== "string") return "";
  let s = value.replace(CONTROL_CHARS_RE, " ").trim();
  // Drop angle-bracket tags entirely — agents send plain identifiers, never markup.
  s = s.replace(/<[^>]*>/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s.trim();
}

/** True when a string contains obviously prohibited active content. */
export function containsActiveContent(value: string): boolean {
  return /<\s*(script|iframe|embed|object|svg|img|on\w+\s*=)/i.test(value);
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ARRAY_ITEMS)
    .map((v) => sanitizeString(v))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Registration validation
// ---------------------------------------------------------------------------

export interface RegisterInput {
  /** Any well-formed provider name (AGENT_KIND_SLUG_PATTERN), not just AGENT_KINDS -- see that constant's comment. */
  agentKind: string;
  repoHint: string;
  ruleTargets: string[];
  capabilities: string[];
  consentMode: "human_required";
}

export type RegisterValidation =
  | { ok: true; value: RegisterInput }
  | { ok: false; status: number; error: string };

/**
 * Validate + sanitize a raw registration body. Enforces:
 *  - consent_mode === "human_required" (no autonomous signup),
 *  - a known agent_kind,
 *  - a present repo_hint,
 *  - size limits, and no active HTML/script payloads,
 *  - rule_targets / capabilities sanitized to short identifier lists.
 */
export function validateRegisterInput(raw: unknown): RegisterValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 400, error: "Invalid request body." };
  }
  const body = raw as Record<string, unknown>;

  // Reject oversized payloads early (cheap defense before per-field work).
  const approxBytes = Buffer.byteLength(JSON.stringify(body));
  if (approxBytes > MAX_REGISTER_BYTES) {
    return { ok: false, status: 413, error: "Registration payload is too large." };
  }

  const consentMode = sanitizeString(body.consent_mode ?? body.consentMode);
  if (consentMode !== "human_required") {
    return {
      ok: false,
      status: 400,
      error:
        'consent_mode must be "human_required". M9R never connects an agent without human approval.',
    };
  }

  const agentKindRaw = sanitizeString(body.agent_kind ?? body.agentKind).toLowerCase();
  const agentKind = AGENT_KIND_SLUG_PATTERN.test(agentKindRaw) ? agentKindRaw : null;
  if (!agentKind) {
    return {
      ok: false,
      status: 400,
      error: "agent_kind must be lowercase letters, numbers, and hyphens only (1-40 characters, no leading/trailing hyphen).",
    };
  }

  const repoHint = sanitizeString(body.repo_hint ?? body.repoHint, MAX_REPO_HINT);
  if (!repoHint) {
    return { ok: false, status: 400, error: "repo_hint is required." };
  }

  const ruleTargets = sanitizeStringArray(body.rule_targets ?? body.ruleTargets);
  const capabilities = sanitizeStringArray(body.capabilities);

  // Reject active content anywhere in the free-text fields.
  if ([repoHint, ...ruleTargets, ...capabilities].some(containsActiveContent)) {
    return { ok: false, status: 400, error: "Prohibited content detected." };
  }

  return {
    ok: true,
    value: { agentKind, repoHint, ruleTargets, capabilities, consentMode: "human_required" },
  };
}

// ---------------------------------------------------------------------------
// Secrets: tokens & setup codes
// ---------------------------------------------------------------------------

/** A scoped agent token. Prefixed so it's recognizable + greppable as a secret. */
export function generateAgentToken(): string {
  return `oak_${randomBytes(32).toString("base64url")}`;
}

/** The setup code an agent uses to poll claim status / retrieve the token. */
export function generateSetupCode(): string {
  return `setup_${randomBytes(18).toString("base64url")}`;
}

/** SHA-256 hex hash. Used for both token_hash and setup_code_hash. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Compare a presented setup code against a stored hash (hash-then-equals). */
export function setupCodeMatches(setupCode: string, storedHash: string): boolean {
  if (!setupCode || !storedHash) return false;
  return hashSecret(setupCode) === storedHash;
}

// ---------------------------------------------------------------------------
// URLs & timing
// ---------------------------------------------------------------------------

export function buildClaimUrl(baseUrl: string, claimId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/claim/${claimId}`;
}

export function claimExpiry(now = Date.now()): string {
  return new Date(now + CLAIM_TTL_MS).toISOString();
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? now > t : true;
}

// ---------------------------------------------------------------------------
// Honest rules-endpoint payloads
// ---------------------------------------------------------------------------

/**
 * OathLock OPERATING instructions — these are NOT workspace behavior rules.
 * They are always-true safety guidance for how an agent should interact with
 * OathLock, and are clearly labeled as such so they're never confused with
 * evidence-backed workspace rules.
 */
export const OATHLOCK_OPERATING_INSTRUCTIONS = [
  "Do not upload secrets, credentials, or tokens to M9R.",
  "Ask the human before submitting any session.",
  "Submit only an approved, redacted session after the work is done.",
] as const;

export interface BaselineRulesResponse {
  mode: "baseline";
  message: string;
  rules: [];
  operating_instructions: string[];
}

/** The exact baseline response when a workspace has no evidence-backed rules yet. */
export function baselineRulesResponse(): BaselineRulesResponse {
  return {
    mode: "baseline",
    message:
      "No evidence-backed workspace rules exist yet. Complete the task, then submit an approved/redacted session so M9R can generate the first rules.",
    rules: [],
    operating_instructions: [...OATHLOCK_OPERATING_INSTRUCTIONS],
  };
}
