/**
 * Agent session result — parsing for the web display surface
 * ----------------------------------------------------------------------------
 * Pure, IO-free helpers that turn a returned `/api/agent/session` JSON response
 * into a normalized shape the session-result page renders. Display only — it
 * neither calls the API nor re-classifies anything.
 *
 * The agent-session response is NOT a full BlackboxReport; it carries summary
 * fields (source quality, parser confidence, findings count, rules) plus the
 * `rule_health` section. `extractRuleHealth` returns the rule health object only
 * when it's actually present and evaluated-shaped, so the panel never shows fake
 * health for a response that didn't load any rules.
 */

import type { RuleHealthReport, RuleHealthItem } from "@/lib/rule-health";

export interface ParsedSessionResult {
  ok: boolean;
  sourceQuality: string | null;
  sourceQualityLabel: string | null;
  parserConfidence: Record<string, unknown> | null;
  findingsCount: number;
  rules: { recommended?: boolean; message?: string } | null;
  ruleHealth: RuleHealthReport | null;
  nextStep: string | null;
}

/**
 * Return the `rule_health` object from a session response, but only when it is
 * actually shaped like one (has a boolean `evaluated`). Otherwise null, so the
 * caller renders no Rule Health panel rather than faking it.
 */
export function extractRuleHealth(input: unknown): RuleHealthReport | null {
  if (!input || typeof input !== "object") return null;
  const rh = (input as Record<string, unknown>).rule_health;
  if (!rh || typeof rh !== "object") return null;
  const obj = rh as Record<string, unknown>;
  if (typeof obj.evaluated !== "boolean") return null;

  const items: RuleHealthItem[] = Array.isArray(obj.items)
    ? (obj.items.filter((i) => i && typeof i === "object") as RuleHealthItem[])
    : [];
  const summary =
    obj.summary && typeof obj.summary === "object"
      ? (obj.summary as RuleHealthReport["summary"])
      : ({
          followed: 0,
          violated: 0,
          not_applicable: 0,
          too_vague: 0,
          needs_review: 0,
          obsolete: 0,
        } as RuleHealthReport["summary"]);

  return { evaluated: obj.evaluated, items, summary };
}

/**
 * Normalize a returned `/api/agent/session` response for display. Returns null
 * when the input doesn't look like a session response at all.
 */
export function parseSessionResult(input: unknown): ParsedSessionResult | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;

  const looksLikeSession =
    "ok" in o || "rule_health" in o || "source_quality" in o || "findings_count" in o;
  if (!looksLikeSession) return null;

  return {
    ok: o.ok === true,
    sourceQuality: typeof o.source_quality === "string" ? o.source_quality : null,
    sourceQualityLabel:
      typeof o.source_quality_label === "string" ? o.source_quality_label : null,
    parserConfidence:
      o.parser_confidence && typeof o.parser_confidence === "object"
        ? (o.parser_confidence as Record<string, unknown>)
        : null,
    findingsCount: typeof o.findings_count === "number" ? o.findings_count : 0,
    rules:
      o.rules && typeof o.rules === "object"
        ? (o.rules as { recommended?: boolean; message?: string })
        : null,
    ruleHealth: extractRuleHealth(o),
    nextStep: typeof o.next_step === "string" ? o.next_step : null,
  };
}

/** Parse a pasted JSON string into a session result. Returns null on bad input. */
export function parseSessionResultJson(raw: string): ParsedSessionResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    // Strip a leading UTF-8 BOM (PowerShell-saved files) before parsing.
    const text = trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed;
    return parseSessionResult(JSON.parse(text));
  } catch {
    return null;
  }
}
