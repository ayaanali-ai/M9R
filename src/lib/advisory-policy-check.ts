// Advisory Policy Check v0 — a DETERMINISTIC, NON-BLOCKING checker that evaluates
// a normalized trace (+ optional prevention rules / findings) and returns
// pass/warn/fail advisories.
//
//   trace → findings → prevention rules → advisory policy check
//
// STRICT RULES: This is advisory only — NOT CI gating, NOT enforcement, NOT
// hosted tracing, NOT a daemon. It makes no LLM/provider calls, invents no exact
// fields, estimates no cost from tokens, and never treats energy/heat as
// measured. "Fail-on-claim" checks fire only when a positive claim is actually
// present; absent claims never invent a failure. Unknown stays unknown.

export type AdvisoryPolicyStatus = "pass" | "warn" | "fail";

export type AdvisoryPolicyCheck = {
  id: string;
  title: string;
  status: AdvisoryPolicyStatus;
  severity: "low" | "medium" | "high";
  reason: string;
  evidence: string[];
  recommendedAction: string;
  relatedPreventionRuleIds: string[];
  limitations: string[];
};

export type AdvisoryPolicyReport = {
  reportVersion: "runleak.policy.v0";
  createdAt: string;
  runName: string;
  overallStatus: AdvisoryPolicyStatus;
  checks: AdvisoryPolicyCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  limitations: string[];
};

type NormalizedTraceLike = {
  run_name?: string;
  exact_model_calls?: number | null;
  exact_token_count?: number | null;
  exact_cost_usd?: number | null;
  exact_energy_wh?: number | null;
  build_result?: string | null;
  lint_result?: string | null;
  limitations?: unknown;
  // Optional provenance a proof-package coercion may attach. A plain normalized
  // trace will not have these, so synthetic/claim checks stay inert.
  source?: { synthetic?: boolean };
  synthetic?: boolean;
};

type PreventionRuleLike = {
  id?: string;
  title?: string;
  leakType?: string;
  severity?: string;
  policyRule?: string;
  limitations?: string[];
};

type FindingLike = { type?: string; severity?: string; title?: string };

const ADVISORY_LIMITATION =
  "Advisory only — non-blocking. Not a CI gate, not enforcement, not production validation.";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function limitationLines(t: NormalizedTraceLike): string[] {
  return Array.isArray(t.limitations)
    ? t.limitations.filter((x): x is string => typeof x === "string")
    : [];
}

function hasEnergyHonestyCaveat(lines: string[]): boolean {
  return lines.some(
    (l) =>
      /energy/i.test(l) &&
      /(not|never).*measur|configurable estimate|stays null/i.test(l),
  );
}

function hasCostHonestyCaveat(lines: string[]): boolean {
  return lines.some(
    (l) => /cost/i.test(l) && /(null|unknown|not supplied|unless|explicit)/i.test(l),
  );
}

function isSynthetic(t: NormalizedTraceLike): boolean {
  return t.source?.synthetic === true || t.synthetic === true;
}

export function createAdvisoryPolicyReport(input: {
  normalizedTrace: NormalizedTraceLike;
  preventionRules?: PreventionRuleLike[];
  findings?: FindingLike[];
}): AdvisoryPolicyReport {
  const t = input.normalizedTrace ?? {};
  const rules = input.preventionRules ?? [];
  const findings = input.findings ?? [];
  const lines = limitationLines(t);

  const modelCalls = num(t.exact_model_calls);
  const tokenCount = num(t.exact_token_count);
  const costUsd = num(t.exact_cost_usd);
  const energyWh = num(t.exact_energy_wh);
  const build = typeof t.build_result === "string" ? t.build_result : null;
  const lint = typeof t.lint_result === "string" ? t.lint_result : null;

  const checks: AdvisoryPolicyCheck[] = [];

  // 1. Missing usage metadata
  {
    const missing = modelCalls === null && tokenCount === null;
    checks.push({
      id: "missing_usage_metadata",
      title: "Usage metadata present",
      status: missing ? "warn" : "pass",
      severity: "medium",
      reason: missing
        ? "Both exact_model_calls and exact_token_count are null — no measured usage to report."
        : "Explicit usage metadata is present (model calls and/or token count).",
      evidence: [
        `exact_model_calls=${modelCalls === null ? "null" : modelCalls}`,
        `exact_token_count=${tokenCount === null ? "null" : tokenCount}`,
      ],
      recommendedAction: missing
        ? "Provide a strict recorded-session JSON or provider usage metadata; otherwise keep usage marked unknown."
        : "No action — usage is explicit.",
      relatedPreventionRuleIds: ["missing_usage_metadata"],
      limitations: [ADVISORY_LIMITATION, "Usage is never inferred when absent."],
    });
  }

  // 2. Energy/heat unknown (never fails without a positive "measured" claim)
  {
    const caveat = hasEnergyHonestyCaveat(lines);
    const status: AdvisoryPolicyStatus =
      energyWh === null ? (caveat ? "pass" : "warn") : "pass";
    checks.push({
      id: "energy_heat_unknown",
      title: "Energy/heat honesty",
      status,
      severity: "low",
      reason:
        energyWh === null
          ? caveat
            ? "exact_energy_wh is null and limitations state energy/heat are not measured."
            : "exact_energy_wh is null but no explicit energy caveat was found in limitations."
          : "exact_energy_wh has a value supplied by the source.",
      evidence: [
        `exact_energy_wh=${energyWh === null ? "null" : energyWh}`,
        caveat ? "energy caveat present in limitations" : "no energy caveat found",
      ],
      recommendedAction:
        "Keep energy as unknown / a configurable estimate until real telemetry exists; never claim it was measured.",
      relatedPreventionRuleIds: [],
      limitations: [ADVISORY_LIMITATION, "Energy/heat are never measured by RunLeak."],
    });
  }

  // 3. Build/lint quality
  {
    let status: AdvisoryPolicyStatus;
    let reason: string;
    if (build === "fail" || lint === "fail") {
      status = "fail";
      reason = "build_result or lint_result is 'fail'.";
    } else if (build === null && lint === null) {
      status = "warn";
      reason = "Both build_result and lint_result are null — quality is unverified.";
    } else {
      status = "pass";
      reason = "Build/lint results are present and not failing.";
    }
    checks.push({
      id: "build_lint_quality",
      title: "Build/lint quality",
      status,
      severity: "medium",
      reason,
      evidence: [
        `build_result=${build ?? "null"}`,
        `lint_result=${lint ?? "null"}`,
      ],
      recommendedAction:
        status === "warn"
          ? "Capture build and lint results in the trace to verify quality."
          : status === "fail"
            ? "Fix the failing build/lint before relying on this run."
            : "No action — quality results present.",
      relatedPreventionRuleIds: ["build_fix_loop"],
      limitations: [ADVISORY_LIMITATION],
    });
  }

  // 4. Prevention rule presence
  {
    const highFindings = findings.filter((f) => f.severity === "high");
    let status: AdvisoryPolicyStatus;
    let reason: string;
    if (highFindings.length > 0 && rules.length === 0) {
      status = "warn";
      reason = `${highFindings.length} high-severity finding(s) exist but no prevention rules were supplied.`;
    } else if (rules.length > 0) {
      status = "pass";
      reason = `${rules.length} prevention rule(s) supplied for the detected findings.`;
    } else {
      status = "pass";
      reason = "No findings require prevention rules.";
    }
    checks.push({
      id: "prevention_rule_presence",
      title: "Prevention rule coverage",
      status,
      severity: "medium",
      reason,
      evidence: [
        `findings=${findings.length}`,
        `high_severity_findings=${highFindings.length}`,
        `prevention_rules=${rules.length}`,
      ],
      recommendedAction:
        status === "warn"
          ? "Generate prevention rules for the high-severity findings (deterministic, finding-based)."
          : "No action.",
      relatedPreventionRuleIds: rules
        .map((r) => r.id)
        .filter((x): x is string => typeof x === "string"),
      limitations: [ADVISORY_LIMITATION, "Rules appear only when a finding maps to one."],
    });
  }

  // 5. Claims drift
  {
    const claimsRule = rules.find((r) => r.id === "claims_drift" || r.leakType === "claims_drift");
    if (claimsRule) {
      checks.push({
        id: "claims_drift",
        title: "Claims drift risk",
        status: "warn",
        severity: "high",
        reason: "A claims_drift prevention rule is present — public copy may exceed measured fields.",
        evidence: [`prevention_rule=${claimsRule.id ?? "claims_drift"}`],
        recommendedAction:
          "Remove or qualify unsupported public claims; only claim what the trace evidence supports.",
        relatedPreventionRuleIds: ["claims_drift"],
        limitations: [ADVISORY_LIMITATION, "Heuristic over rule presence; not a factual audit."],
      });
    }
  }

  // 6. Real vs synthetic proof
  {
    const synthetic = isSynthetic(t);
    const hasExactUsage = modelCalls !== null || tokenCount !== null;
    checks.push({
      id: "real_vs_synthetic",
      title: "Real vs synthetic proof",
      status: synthetic ? "warn" : "pass",
      severity: "low",
      reason: synthetic
        ? "This input is labeled synthetic — valid as an example, but not a real measured run."
        : hasExactUsage
          ? "Input is not synthetic and carries explicit usage."
          : "Input is not labeled synthetic.",
      evidence: [
        `synthetic=${synthetic}`,
        `has_exact_usage=${hasExactUsage}`,
      ],
      recommendedAction: synthetic
        ? "Label this clearly as a synthetic example; do not present it as a real measured run."
        : "No action.",
      relatedPreventionRuleIds: [],
      limitations: [ADVISORY_LIMITATION, "Synthetic proof is labeled, not invalid."],
    });
  }

  // 7. Cost honesty (never fails without a positive "savings proven" claim)
  {
    const caveat = hasCostHonestyCaveat(lines);
    let status: AdvisoryPolicyStatus;
    let reason: string;
    if (costUsd === null && tokenCount !== null) {
      status = "warn";
      reason = "Token count is present but exact_cost_usd is null — cost cannot be reported.";
    } else if (costUsd === null) {
      status = caveat ? "pass" : "warn";
      reason = caveat
        ? "exact_cost_usd is null and limitations state cost is unknown / not supplied."
        : "exact_cost_usd is null and no explicit cost caveat was found.";
    } else {
      status = "pass";
      reason = "exact_cost_usd is explicitly supplied.";
    }
    checks.push({
      id: "cost_honesty",
      title: "Cost honesty",
      status,
      severity: "medium",
      reason,
      evidence: [
        `exact_cost_usd=${costUsd === null ? "null" : costUsd}`,
        `exact_token_count=${tokenCount === null ? "null" : tokenCount}`,
        caveat ? "cost caveat present in limitations" : "no cost caveat found",
      ],
      recommendedAction:
        "Never derive cost from tokens; report cost only from explicit per-call costUsd.",
      relatedPreventionRuleIds: ["missing_usage_metadata"],
      limitations: [ADVISORY_LIMITATION, "Cost is never estimated from tokens."],
    });
  }

  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  const overallStatus: AdvisoryPolicyStatus =
    summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";

  return {
    reportVersion: "runleak.policy.v0",
    createdAt: new Date().toISOString(),
    runName: typeof t.run_name === "string" ? t.run_name : "Untitled run",
    overallStatus,
    checks,
    summary,
    limitations: [
      ADVISORY_LIMITATION,
      "Deterministic checks over explicit fields only; no values are estimated.",
      "Fail-on-claim checks fire only when a positive claim is present; absent claims never fail.",
    ],
  };
}
