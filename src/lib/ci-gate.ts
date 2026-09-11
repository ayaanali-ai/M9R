// CI Gate Dry-Run v0 — consume a runleak.policy.v0 advisory report and produce a
// deterministic gate result. DEFAULT IS DRY-RUN AND NON-BLOCKING.
//
// This is the first, SAFE version of an enforcement surface: it can report what
// *would* block, but only actually blocks (exitCode 1) in explicit `enforce` mode
// when the threshold is met. It is NOT a GitHub Action, NOT hosted tracing, NOT a
// daemon, NOT production enforcement.
//
// STRICT RULES: It only consumes the policy report. It invents no checks, and
// never recomputes tokens/cost/energy. Output is deterministic except createdAt.

export type CIGateMode = "dry-run" | "enforce";
export type CIGateThreshold = "fail" | "warn";

type PolicyStatus = "pass" | "warn" | "fail";

export type CIGateResult = {
  resultVersion: "runleak.ci-gate.v0";
  createdAt: string;
  mode: CIGateMode;
  threshold: CIGateThreshold;
  inputPolicyStatus: PolicyStatus;
  wouldBlock: boolean;
  exitCode: number;
  reason: string;
  blockingChecks: Array<{
    id: string;
    title: string;
    status: "warn" | "fail";
    severity: "low" | "medium" | "high";
    reason: string;
    recommendedAction: string;
  }>;
  limitations: string[];
};

type PolicyCheckLike = {
  id?: string;
  title?: string;
  status?: string;
  severity?: string;
  reason?: string;
  recommendedAction?: string;
};

type PolicyReportLike = {
  overallStatus?: string;
  checks?: PolicyCheckLike[];
};

function asStatus(v: unknown): PolicyStatus {
  return v === "fail" || v === "warn" ? v : "pass";
}

function asSeverity(v: unknown): "low" | "medium" | "high" {
  return v === "high" || v === "medium" ? v : "low";
}

// Which check statuses the threshold treats as blocking.
function isBlockingStatus(status: string, threshold: CIGateThreshold): boolean {
  if (threshold === "warn") return status === "warn" || status === "fail";
  return status === "fail"; // threshold === "fail"
}

export function evaluateCIGate(input: {
  policyReport: PolicyReportLike;
  mode?: CIGateMode;
  threshold?: CIGateThreshold;
}): CIGateResult {
  const mode: CIGateMode = input.mode === "enforce" ? "enforce" : "dry-run";
  const threshold: CIGateThreshold = input.threshold === "warn" ? "warn" : "fail";

  const report = input.policyReport ?? {};
  const inputPolicyStatus = asStatus(report.overallStatus);
  const checks: PolicyCheckLike[] = Array.isArray(report.checks) ? report.checks : [];

  const blockingChecks = checks
    .filter((c) => isBlockingStatus(String(c.status), threshold))
    .map((c) => ({
      id: typeof c.id === "string" ? c.id : "unknown",
      title: typeof c.title === "string" ? c.title : "Untitled check",
      status: (c.status === "fail" ? "fail" : "warn") as "warn" | "fail",
      severity: asSeverity(c.severity),
      reason: typeof c.reason === "string" ? c.reason : "",
      recommendedAction:
        typeof c.recommendedAction === "string" ? c.recommendedAction : "",
    }));

  const wouldBlock = blockingChecks.length > 0;

  // exitCode: dry-run is ALWAYS 0. enforce returns 1 only when the threshold is met.
  const exitCode = mode === "enforce" && wouldBlock ? 1 : 0;

  let reason: string;
  if (mode === "dry-run") {
    reason = wouldBlock
      ? `Dry-run: ${blockingChecks.length} check(s) would block at threshold "${threshold}", but dry-run does not block (exit 0).`
      : `Dry-run: no checks meet the "${threshold}" threshold; nothing would block (exit 0).`;
  } else {
    reason = wouldBlock
      ? `Enforce: ${blockingChecks.length} check(s) meet the "${threshold}" threshold — blocking (exit 1).`
      : `Enforce: no checks meet the "${threshold}" threshold — not blocking (exit 0).`;
  }

  return {
    resultVersion: "runleak.ci-gate.v0",
    createdAt: new Date().toISOString(),
    mode,
    threshold,
    inputPolicyStatus,
    wouldBlock,
    exitCode,
    reason,
    blockingChecks,
    limitations: [
      "Default mode is dry-run and non-blocking; enforce mode must be requested explicitly.",
      "Consumes a runleak.policy.v0 report only — no checks are invented, recomputed, or measured.",
      "Not a GitHub Action, not hosted CI, not a daemon, not production enforcement.",
      "Tokens, cost, energy, and heat are never recomputed here.",
    ],
  };
}
