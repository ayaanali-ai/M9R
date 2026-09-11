/**
 * Agent loop demo fixture (SYNTHETIC — clearly labeled in the UI)
 * ----------------------------------------------------------------------------
 * A single, honestly-labeled example of the two-run rule proof loop so the
 * dashboard can demonstrate the full cycle without external testers:
 *
 *   Run A: repeated edits / retry spiral / missing verification
 *     → M9R recommends a rule
 *       → human promotes it
 *         → Run B loads the rule and submits evidence
 *           → Rule Health evaluates (here: followed)
 *
 * Nothing here is real telemetry. The UI must label it "Example (synthetic)".
 * The copy is produced by buildTwoRunProof so it inherits the conservative,
 * non-overclaiming wording (no "proved", "guaranteed", "saved", "fixed").
 */

import { buildTwoRunProof, type TwoRunProof } from "@/lib/agent-run-core";

export const DEMO_PROOF_LABEL = "Example (synthetic)";

/** A followed-outcome demo: the rule held in the later run. */
export const DEMO_TWO_RUN_PROOF: TwoRunProof = buildTwoRunProof({
  runA: {
    runId: "demo-run-a",
    taskTitle: "Fix the failing build",
    rulesLoadedCount: 0,
    status: "completed",
  },
  rule: {
    id: "demo-rule-edit-thrash",
    title: "Inspect the root cause before re-editing the same file",
    ruleType: "edit_thrash_prevention",
  },
  runB: {
    runId: "demo-run-b",
    taskTitle: "Add a config option",
    rulesLoadedCount: 1,
    status: "completed",
  },
  health: "followed",
});
