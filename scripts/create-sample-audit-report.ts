// Generate the synthetic sample-trace audit artifacts deterministically.
// SYNTHETIC / REDACTED — not customer data, not a real recording, no secrets.
// Mirrors examples/sample-traces/opencode-terminal-log.example.md evidence.
//
// Pipeline: synthetic normalized fixture -> detectors -> prevention rules ->
// advisory policy -> CI dry-run -> proof package. No provider calls, no measured
// token/cost/energy values. Unknown stays unknown.
import { writeFileSync } from "node:fs";
import type { NormalizedManualTrace } from "@/lib/manual-trace-normalizer";
import { detectCodingAgentWaste } from "@/lib/coding-agent-detectors";
import { getPreventionRulesForFindings } from "@/lib/prevention-rules";
import { createAdvisoryPolicyReport } from "@/lib/advisory-policy-check";
import { evaluateCIGate } from "@/lib/ci-gate";
import { createProofPackage } from "@/lib/proof-package";

const DIR = "examples/sample-traces";
const write = (name: string, obj: unknown) => {
  const p = `${DIR}/${name}`;
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  console.log(`Wrote ${p}`);
};

// 1) Synthetic normalized fixture mirroring the OpenCode sample evidence.
// Exact usage fields stay null — no measured token/cost/energy values invented.
const normalized: NormalizedManualTrace = {
  run_name: "SYNTHETIC OpenCode-style run (sample audit)",
  objective: "Fix a failing build and tidy the homepage.",
  files_changed: ["src/app/layout.tsx", "src/components/Hero.tsx", "src/app/page.tsx"],
  components_created: [],
  pages_updated: [],
  commands_run: ["npm run build", "npm run build", "npm run build", "npm run build", "npm run lint"],
  lint_result: "pass",
  build_result: "fail",
  known_errors: [
    "Type error in src/app/page.tsx",
    "failed again with the same error after another attempt",
  ],
  correction_loops: "high",
  suspected_waste_patterns: [],
  repeated_context_risks: "none",
  redundant_edit_risks: "none",
  claims_risks: "none",
  quality_checks: { build_passes: false, lint_passes: true },
  trace_kind: "normalized_manual",
  limitations: [
    "pasted the entire build log (thousands of lines, truncated) into the run each time",
    "tried again, same error, another attempt after several attempts before diagnosing",
    "re-ran the same grep search repeatedly with no new input",
    "usage unknown; no token metadata provided",
  ],
  exact_token_count: null,
  exact_model_calls: null,
  exact_cost_usd: null,
  exact_energy_wh: null,
};

const SYNTH_NOTE =
  "SYNTHETIC / REDACTED — not customer data, not production validation. Mirrors examples/sample-traces/opencode-terminal-log.example.md. No measured token/cost/energy values.";

write("opencode-audit.normalized.example.json", { _comment: SYNTH_NOTE, ...normalized });

// 2) Findings from the real detector (never handwritten).
const findings = detectCodingAgentWaste(normalized);
write("opencode-audit.findings.example.json", {
  _comment: SYNTH_NOTE,
  findingTypes: findings.map((f) => f.type),
  findings,
});

// 3) Prevention rules mapped deterministically from findings.
const preventionRules = getPreventionRulesForFindings({ findings });
write("opencode-audit.prevention-rules.example.json", {
  _comment: SYNTH_NOTE,
  preventionRules,
});

// 4) Advisory policy report.
const policyReport = createAdvisoryPolicyReport({
  normalizedTrace: normalized,
  findings,
  preventionRules,
});
write("opencode-audit.policy-report.example.json", policyReport);

// 5) CI gate dry-run (default mode + fail threshold).
const ciGate = evaluateCIGate({ policyReport, mode: "dry-run", threshold: "fail" });
write("opencode-audit.ci-gate.example.json", ciGate);

// 6) Proof package (clearly synthetic).
const proofPackage = createProofPackage({
  normalizedTracePath: `${DIR}/opencode-audit.normalized.example.json`,
  normalizedTrace: normalized,
  findings,
  preventionRules,
  synthetic: true,
});
write("opencode-audit.proof-package.example.json", proofPackage);

console.log(
  `\nfindings: ${findings.map((f) => f.type).join(", ")}` +
    `\npolicy overall: ${policyReport.overallStatus}` +
    `\nci-gate: mode=${ciGate.mode} wouldBlock=${ciGate.wouldBlock} exitCode=${ciGate.exitCode}`,
);
