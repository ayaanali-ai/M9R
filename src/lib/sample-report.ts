// Single source of truth for the synthetic sample-report proof case.
// Not customer data. Numbers must match the local CLI / homepage proof case
// and must not change without updating docs/claims.md cost-attribution rules.
import type { WasteFinding } from "@/lib/resource-ledger";

export const SAMPLE_REPORT = {
  // Bad ("run") trace
  badCalls: 17,
  totalTokens: 92_000,
  totalCostUsd: 1.42,
  // Fixed trace
  fixedCalls: 11,
  fixedTokens: 41_800,
  fixedCostUsd: 0.74,
  // Detected repeated-context waste (the only live detector)
  wastedTokens: 73_680,
  wastedCostUsd: 0.18,
  // Portion of the bad-vs-fixed delta the detector does NOT explain
  unattributedDeltaUsd: 0.5,
} as const;

// Total bad-vs-fixed cost delta ($0.68), derived so it can never drift from the
// two cost numbers above.
export const SAMPLE_TOTAL_DELTA_USD =
  Math.round((SAMPLE_REPORT.totalCostUsd - SAMPLE_REPORT.fixedCostUsd) * 100) / 100;

export const SAMPLE_FINDINGS: WasteFinding[] = [
  {
    id: "rc-001",
    type: "repeated_context",
    title: "Repeated project context across steps 3–7",
    summary:
      "The same 18,420-token context block was passed into five model calls instead of being cached after the first use.",
    affectedSteps: [4, 5, 6, 7],
    totalTokensInvolved: SAMPLE_REPORT.totalTokens,
    wastedTokens: SAMPLE_REPORT.wastedTokens,
    estimatedCostWasteUsd: SAMPLE_REPORT.wastedCostUsd,
    confidence: "high",
    evidence: [
      "Same 18,420-token block hashed identically in steps 3, 4, 5, 6, 7.",
      "First occurrence at step-3; four subsequent repeats (steps 4–7).",
      "Detection method: block_id_and_similarity.",
    ],
    recommendation:
      "Cache the document summary once and pass a reference ID or short summary into later calls instead of the full block.",
  },
];
