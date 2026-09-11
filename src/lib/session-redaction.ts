/**
 * Session Redaction — OathLock Guided Analyze Flow
 * ----------------------------------------------------------------------------
 * Pure, deterministic, dependency-free redaction of a pasted/uploaded coding
 * agent session BEFORE it is analyzed. This is the privacy gate for the guided
 * flow: the user sees a redacted preview and must consent before analysis runs.
 *
 * Honesty rules (non-negotiable):
 *  - We NEVER claim guaranteed safety. Automatic redaction helps; it is not
 *    perfect, and the returned `confidence` + `warnings` say so plainly.
 *  - Redaction is preview-first: callers show `redactedText` and the summary,
 *    and only submit after explicit user approval.
 *  - This module does no IO and never phones home — it is a string transform.
 *
 * Each secret is replaced with a typed placeholder like `[REDACTED:OPENAI_KEY]`
 * so the structure of the session is preserved (the parser still sees a token
 * in that position) without leaking the value.
 */

export type RedactionConfidence = "high" | "medium" | "low";

export interface RedactionResult {
  /** The session text with secrets replaced by typed placeholders. */
  redactedText: string;
  /** Short, human summary of what was redacted. */
  redactionSummary: string;
  /** Count of redactions per detected type. */
  countsByType: Record<string, number>;
  /** Honest warnings — always includes the "not perfect" notice. */
  warnings: string[];
  /** How confident we are the redaction is reasonably complete. */
  confidence: RedactionConfidence;
}

/** The standard, honest disclaimer. Exported so the UI can reuse the exact text. */
export const REDACTION_DISCLAIMER =
  "Automatic redaction helps, but it is not perfect. Review before analyzing.";

interface Rule {
  type: string;
  re: RegExp;
  /** When true, only the capture group (the value) is replaced, label kept. */
  valueOnly?: boolean;
  /** Heuristic rules are noisier and lower the overall confidence. */
  heuristic?: boolean;
}

// Order matters: most specific patterns first, broad heuristics last, so a
// provider key is labeled as such instead of being swallowed by the generic
// high-entropy catch-all.
const RULES: Rule[] = [
  // Private keys (PEM blocks) — multiline.
  {
    type: "private_key",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },
  // JWTs (Supabase anon/service-role tokens are JWTs, hence before generic).
  {
    type: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // Anthropic keys (before OpenAI: both start with `sk-`).
  { type: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  // Stripe keys (before generic openai `sk-`).
  { type: "stripe_key", re: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  // OpenAI keys (sk-, sk-proj-).
  { type: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, and fine-grained PATs).
  { type: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // AWS access key id.
  { type: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Supabase project URLs.
  { type: "supabase_url", re: /\bhttps?:\/\/[a-z0-9]{16,}\.supabase\.co\b/g },
  // Database connection URLs (with embedded credentials).
  {
    type: "database_url",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s'"<>]+/g,
  },
  // Bearer tokens in Authorization headers.
  { type: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, valueOnly: false },
  // Generic `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, `*_PASSWORD=` env assignments.
  {
    type: "env_secret",
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_]?KEY)[A-Z0-9_]*)\s*=\s*(["']?)([^\s"']+)\2/g,
  },
  // Inline password / passwd / pwd assignments (key: value or key=value).
  {
    type: "password",
    re: /\b(password|passwd|pwd)\b\s*[:=]\s*(["']?)([^\s"']{3,})\2/gi,
  },
  // Email addresses.
  {
    type: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    heuristic: true,
  },
  // Generic high-entropy long strings (catch-all). Runs LAST so it only catches
  // what the specific rules above did not. Heuristic → lowers confidence.
  {
    type: "high_entropy",
    re: /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
    heuristic: true,
  },
];

function placeholder(type: string): string {
  return `[REDACTED:${type.toUpperCase()}]`;
}

/**
 * Redact secrets from a session transcript. Deterministic and side-effect free.
 *
 * `includeHeuristics` (default true) controls the noisy, false-positive-prone
 * rules (`high_entropy`, `email`). Leave it on for real session transcripts,
 * where a missed real secret is worse than an over-eager guess. Turn it off
 * for short structured labels (e.g. an ACP tool-call title) where those two
 * rules have no real secrets to catch but readily blank out a legitimate,
 * short, dash-heavy string like a UUID -- the specific, high-confidence
 * rules (API keys, tokens, private keys, database URLs, ...) still run.
 */
export function redactSession(input: string, options?: { includeHeuristics?: boolean }): RedactionResult {
  const includeHeuristics = options?.includeHeuristics ?? true;
  const text = input ?? "";
  const countsByType: Record<string, number> = {};
  let redactedText = text;

  for (const rule of RULES) {
    if (rule.heuristic && !includeHeuristics) continue;
    rule.re.lastIndex = 0;
    redactedText = redactedText.replace(rule.re, (match, ...groups) => {
      // env_secret / password rules: keep the key label, redact only the value.
      if (rule.type === "env_secret") {
        const key = groups[0] as string;
        countsByType[rule.type] = (countsByType[rule.type] ?? 0) + 1;
        return `${key}=${placeholder(rule.type)}`;
      }
      if (rule.type === "password") {
        const key = groups[0] as string;
        countsByType[rule.type] = (countsByType[rule.type] ?? 0) + 1;
        return `${key}=${placeholder(rule.type)}`;
      }
      // Don't double-redact something already replaced.
      if (match.startsWith("[REDACTED:")) return match;
      countsByType[rule.type] = (countsByType[rule.type] ?? 0) + 1;
      return placeholder(rule.type);
    });
  }

  const total = Object.values(countsByType).reduce((a, n) => a + n, 0);

  const warnings: string[] = [REDACTION_DISCLAIMER];
  if (countsByType.high_entropy) {
    warnings.push(
      "Some redactions are heuristic (long high-entropy strings) and may include false positives — check the preview.",
    );
  }
  if (total === 0) {
    warnings.push(
      "No obvious secrets were detected. This does not guarantee the session is free of sensitive data.",
    );
  }

  const confidence = deriveConfidence(countsByType, total);
  const redactionSummary = buildSummary(countsByType, total);

  return { redactedText, redactionSummary, countsByType, warnings, confidence };
}

function deriveConfidence(
  countsByType: Record<string, number>,
  total: number,
): RedactionConfidence {
  const heuristicCount = (countsByType.high_entropy ?? 0) + (countsByType.email ?? 0);
  const specificCount = total - heuristicCount;

  // Nothing found, or everything matched a specific named pattern → high.
  if (total === 0 || heuristicCount === 0) return "high";
  // Lots of heuristic matches → the input is noisy; be honest it's lower.
  if (heuristicCount >= 5 && specificCount === 0) return "low";
  return "medium";
}

function buildSummary(countsByType: Record<string, number>, total: number): string {
  if (total === 0) return "No secrets detected. Review the preview before analyzing.";
  const parts = Object.entries(countsByType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type.replace(/_/g, " ")}`);
  return `Redacted ${total} item${total === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}
