// Sample normalized runs for the /compare page, taken verbatim from
// docs/proof/test-002-mass-energy-ledger/test-002-normalized-trace.json (mapped
// to the NormalizedManualTrace shape). Used only to demonstrate the comparison;
// no numbers are invented — exact_* fields are null as in the source.
import type { NormalizedManualTrace } from "@/lib/manual-trace-normalizer";

export const SAMPLE_BASELINE_RUN: NormalizedManualTrace = {
  run_name: "Baseline — Mass & Energy Ledger implementation",
  objective:
    "Implement the RunLeak Mass & Energy Ledger PRD while preserving analyzer behavior and claims discipline.",
  files_changed: [
    "src/app/globals.css",
    "src/components/Nav.tsx",
    "src/components/Footer.tsx",
    "src/components/Logo.tsx",
    "src/app/page.tsx",
    "src/app/report/sample/page.tsx",
    "src/app/admin/submissions/page.tsx",
    "src/lib/resource-ledger.ts",
    "src/app/bench/page.tsx",
    "docs/claims.md",
    "public/logo.png",
  ],
  components_created: [
    "src/components/Logo.tsx",
    "src/components/MassEnergyLedger.tsx",
    "src/components/RootCauseDiagnosis.tsx",
    "src/components/PreventionPlan.tsx",
  ],
  pages_updated: [
    "/ (homepage positioning + proof cards + governor roadmap)",
    "/report/sample (root-cause, prevention, ledger, caveats)",
    "/bench (new)",
  ],
  commands_run: ["npm run lint", "npm run build"],
  lint_result: "pass",
  build_result: "pass",
  known_errors: [
    "Stray '>' introduced in Footer.tsx during wordmark swap (fixed before build).",
    "bg-lime text-black buttons had poor contrast on new blue (changed to text-white).",
  ],
  correction_loops: "moderate",
  suspected_waste_patterns: [
    "Re-reads forced by linter/sed editing files between Read and Edit ('modified since read').",
    "Self-inflicted fix loop (Footer typo, button contrast).",
    "Ambiguous-match Edit retry on duplicated CTA strings.",
    "Broad accent sweep across ~9 files via sed instead of a single token change.",
    "Required caveat copy authored in multiple page locations.",
  ],
  repeated_context_risks: "moderate",
  redundant_edit_risks: "moderate",
  claims_risks: "low",
  quality_checks: { build_passes: true, lint_passes: true },
  limitations: [
    "No self-trace available; process waste assessed qualitatively.",
    "Logo shipped as 437 KB PNG via next/image (addressed in controlled run).",
  ],
  exact_token_count: null,
  exact_model_calls: null,
  exact_cost_usd: null,
  exact_energy_wh: null,
  trace_kind: "normalized_manual",
};

export const SAMPLE_CONTROLLED_RUN: NormalizedManualTrace = {
  run_name: "Controlled cleanup — Test Case 002B",
  objective:
    "Improve implementation quality while reducing redundant edits, repeated context, and correction loops, without expanding scope.",
  files_changed: [
    "public/runleak-logo.svg",
    "src/components/Logo.tsx",
    "src/lib/sample-report.ts",
    "src/app/report/sample/page.tsx",
    "src/app/bench/page.tsx",
    "src/app/globals.css",
  ],
  components_created: ["src/lib/sample-report.ts (sample fixture module)"],
  pages_updated: [
    "/report/sample (uses shared fixture + caveat constant)",
    "/bench (renders shared caveat constant)",
  ],
  commands_run: ["npm run lint", "npm run build"],
  lint_result: "pass",
  build_result: "pass",
  known_errors: [],
  correction_loops: "none",
  suspected_waste_patterns: [
    "Minor: initial SVG used blue letters; canonical should be white (corrected in Test Case 002C).",
  ],
  repeated_context_risks: "low",
  redundant_edit_risks: "low",
  claims_risks: "low",
  quality_checks: { build_passes: true, lint_passes: true },
  limitations: [
    "No automated tests executed (no runner installed); documented test plan only.",
    "No self-trace available; reductions are structural counts, not measured inference savings.",
    "public/logo.png left in place as source asset but unreferenced by code.",
  ],
  exact_token_count: null,
  exact_model_calls: null,
  exact_cost_usd: null,
  exact_energy_wh: null,
  trace_kind: "normalized_manual",
};
