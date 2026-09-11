// Minimal local CLI: evaluate a normalized trace (or a runleak.proof.v0 package)
// against deterministic advisory policy checks and emit a runleak.policy.v0
// report. NOT a CI gate, SDK, DB, or hosted API — advisory only, no external calls.
//
// Usage:
//   npm run policy:check -- <normalized-trace.json> [options]
//   npm run policy:check -- <proof-package.json> [options]
//
// Options:
//   --out <path>          Write the policy report JSON here (default: stdout)
//   --prevention <path>   JSON array (or { preventionRules: [...] }) of prevention rules
//   --findings <path>     JSON array (or { findings: [...] }) of findings
//   --proof <path>        A runleak.proof.v0 package to source rules/findings/synthetic from
import { readFileSync, writeFileSync } from "node:fs";
import { createAdvisoryPolicyReport } from "@/lib/advisory-policy-check";

const USAGE = `Usage: npm run policy:check -- <normalized-trace.json | proof-package.json> [options]

Options:
  --out <path>          Write report JSON here (default: stdout)
  --prevention <path>   Prevention-rules JSON (array or { preventionRules })
  --findings <path>     Findings JSON (array or { findings })
  --proof <path>        runleak.proof.v0 package to source rules/findings/synthetic

Advisory only — non-blocking. No external calls; nothing is estimated.`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(v: unknown, key: "preventionRules" | "findings"): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

function isProofPackage(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).packageVersion === "runleak.proof.v0"
  );
}

// Coerce a proof package into a normalized-trace-like object so the checker can
// evaluate it directly (carrying synthetic provenance + limitations).
function normalizedFromProof(pkg: Record<string, unknown>): Record<string, unknown> {
  const summary = (pkg.summary ?? {}) as Record<string, unknown>;
  const source = (pkg.source ?? {}) as Record<string, unknown>;
  return {
    run_name: summary.runName,
    exact_model_calls: summary.exactModelCalls ?? null,
    exact_token_count: summary.exactTokenCount ?? null,
    exact_cost_usd: summary.exactCostUsd ?? null,
    exact_energy_wh: summary.exactEnergyWh ?? null,
    build_result: summary.buildResult ?? null,
    lint_result: summary.lintResult ?? null,
    limitations: pkg.limitations ?? [],
    source: { synthetic: source.synthetic === true },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  let inputPath: string | undefined;
  let outPath: string | undefined;
  let preventionPath: string | undefined;
  let findingsPath: string | undefined;
  let proofPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") outPath = argv[++i];
    else if (arg === "--prevention") preventionPath = argv[++i];
    else if (arg === "--findings") findingsPath = argv[++i];
    else if (arg === "--proof") proofPath = argv[++i];
    else if (!arg.startsWith("-") && !inputPath) inputPath = arg;
  }

  if (!inputPath) {
    console.error(USAGE);
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = readJson(inputPath);
  } catch {
    console.error(`Error: cannot read/parse input "${inputPath}".`);
    process.exit(1);
  }

  // The main input can be a normalized trace OR a proof package.
  let normalizedTrace: Record<string, unknown>;
  let rulesFromInput: unknown[] = [];
  let findingsFromInput: unknown[] = [];
  if (isProofPackage(raw)) {
    normalizedTrace = normalizedFromProof(raw);
    rulesFromInput = asArray(raw.preventionRules, "preventionRules");
    findingsFromInput = asArray(raw.findings, "findings");
  } else {
    normalizedTrace = raw as Record<string, unknown>;
  }

  // Explicit --proof can supply/override rules + findings + synthetic provenance.
  if (proofPath) {
    try {
      const proof = readJson(proofPath);
      if (isProofPackage(proof)) {
        rulesFromInput = asArray(proof.preventionRules, "preventionRules");
        findingsFromInput = asArray(proof.findings, "findings");
        const src = (proof.source ?? {}) as Record<string, unknown>;
        if (src.synthetic === true) {
          normalizedTrace = { ...normalizedTrace, source: { synthetic: true } };
        }
      }
    } catch {
      console.error(`Error: cannot read/parse proof package "${proofPath}".`);
      process.exit(1);
    }
  }

  try {
    if (preventionPath) rulesFromInput = asArray(readJson(preventionPath), "preventionRules");
    if (findingsPath) findingsFromInput = asArray(readJson(findingsPath), "findings");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const report = createAdvisoryPolicyReport({
    normalizedTrace,
    preventionRules: rulesFromInput as Parameters<
      typeof createAdvisoryPolicyReport
    >[0]["preventionRules"],
    findings: findingsFromInput as Parameters<
      typeof createAdvisoryPolicyReport
    >[0]["findings"],
  });

  const output = JSON.stringify(report, null, 2);
  if (outPath) {
    writeFileSync(outPath, output + "\n");
    console.error(`Wrote ${outPath} (overall: ${report.overallStatus})`);
  } else {
    console.log(output);
  }
}

main();
