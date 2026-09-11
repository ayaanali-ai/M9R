// RunLeak Proof Package v0 — bundle a normalized trace + (optional) findings and
// prevention rules into a single, shareable proof artifact.
//
// STRICT RULES: This makes NO provider calls and invents NO exact values. Exact
// fields are copied verbatim from the normalized trace only; missing values stay
// null/unknown. It never estimates cost from tokens and never treats energy/heat
// as measured. Output is deterministic except for `createdAt`. The package always
// distinguishes a real (live/imported) proof from a synthetic example.

export type RunLeakProofPackage = {
  packageVersion: "runleak.proof.v0";
  createdAt: string;
  source: {
    recordedTracePath?: string;
    normalizedTracePath?: string;
    synthetic?: boolean;
  };
  summary: {
    runName: string;
    exactModelCalls: number | null;
    exactTokenCount: number | null;
    exactCostUsd: number | null;
    exactEnergyWh: number | null;
    buildResult: string | null;
    lintResult: string | null;
  };
  findings: unknown[];
  preventionRules: unknown[];
  limitations: string[];
  allowedClaims: string[];
  forbiddenClaims: string[];
};

// Minimal shape we read from a normalized trace. Extra fields are ignored.
type NormalizedTraceLike = {
  run_name?: string;
  exact_model_calls?: number | null;
  exact_token_count?: number | null;
  exact_cost_usd?: number | null;
  exact_energy_wh?: number | null;
  build_result?: string | null;
  lint_result?: string | null;
  limitations?: unknown;
};

// Conservative claims discipline — identical for every package so reviewers can
// rely on it. Forbidden claims are a hard floor.
const ALLOWED_CLAIMS: string[] = [
  "Imported a structured trace into RunLeak's normalized schema.",
  "Exact usage (model calls / tokens / cost) is shown only when explicitly present.",
  "Unknown remains unknown; missing values stay null.",
  "Prevention rules are deterministic and finding-based, not LLM-generated.",
];

const FORBIDDEN_CLAIMS: string[] = [
  "production validated",
  "customer savings proven",
  "energy measured",
  "guaranteed cost reduction",
  "works across all providers",
];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function createProofPackage(input: {
  recordedTracePath?: string;
  normalizedTracePath?: string;
  normalizedTrace: NormalizedTraceLike;
  findings?: unknown[];
  preventionRules?: unknown[];
  synthetic?: boolean;
}): RunLeakProofPackage {
  const t = input.normalizedTrace ?? {};
  const findings = input.findings ?? [];
  const preventionRules = input.preventionRules ?? [];
  const synthetic = input.synthetic === true;

  // Limitations: copy verbatim from the normalized trace, then append package-
  // level honesty notes (no invented values; provenance of this package).
  const traceLimitations = stringArray(t.limitations);
  const packageLimitations = [
    synthetic
      ? "SYNTHETIC proof package — example data, not a real measured or live trace."
      : "Exact fields are copied verbatim from the normalized trace; none are invented.",
    findings.length === 0
      ? "No waste findings supplied: this package proves usage capture, not waste detection."
      : "Findings are qualitative detector output unless explicit measured fields exist.",
    preventionRules.length === 0
      ? "No prevention rules supplied: no rules are fabricated without matching findings."
      : "Prevention rules are deterministic, finding-based mappings — not measured savings.",
    "Cost is null unless explicitly supplied; energy/heat are never measured.",
    "This package does not prove cost savings or production readiness.",
  ];

  return {
    packageVersion: "runleak.proof.v0",
    createdAt: new Date().toISOString(),
    source: {
      ...(input.recordedTracePath ? { recordedTracePath: input.recordedTracePath } : {}),
      ...(input.normalizedTracePath ? { normalizedTracePath: input.normalizedTracePath } : {}),
      synthetic,
    },
    summary: {
      runName: str(t.run_name) ?? "Untitled run",
      exactModelCalls: num(t.exact_model_calls),
      exactTokenCount: num(t.exact_token_count),
      exactCostUsd: num(t.exact_cost_usd),
      exactEnergyWh: num(t.exact_energy_wh),
      buildResult: str(t.build_result),
      lintResult: str(t.lint_result),
    },
    findings,
    preventionRules,
    limitations: [...traceLimitations, ...packageLimitations],
    allowedClaims: ALLOWED_CLAIMS,
    forbiddenClaims: FORBIDDEN_CLAIMS,
  };
}
