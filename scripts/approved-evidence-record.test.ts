import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractApprovedEvidenceRecord,
  normalizeApprovedEvidenceRecord,
} from "../src/lib/approved-evidence-record.ts";

test("extracts the human-approved record sections without raw session content", () => {
  const record = extractApprovedEvidenceRecord(`Task:\nFix navigation\nWhat changed:\n- Preserved the selected agent\nWhy these changes were made:\n- Keep context stable\nScope deviations:\nNone\nLimitations or unresolved issues:\n- Historical runs have no structured record\nVerification commands:\n- npm test`);

  assert.deepEqual(record.what_changed, { recorded: true, items: ["Preserved the selected agent"] });
  assert.deepEqual(record.why, { recorded: true, items: ["Keep context stable"] });
  assert.deepEqual(record.scope_deviations, { recorded: true, items: [] });
  assert.deepEqual(record.limitations, {
    recorded: true,
    items: ["Historical runs have no structured record"],
  });
});

test("missing historical sections remain explicitly not recorded", () => {
  const record = extractApprovedEvidenceRecord("Task:\nOlder approved evidence\nResults:\nTests passed");
  assert.equal(record.what_changed.recorded, false);
  assert.equal(record.why.recorded, false);
  assert.equal(record.scope_deviations.recorded, false);
  assert.equal(record.limitations.recorded, false);
});

test("normalization rejects malformed snapshots and strips active markup", () => {
  const record = normalizeApprovedEvidenceRecord({
    what_changed: { recorded: true, items: ["<script>alert(1)</script><b>Safe summary</b>"] },
    why: "malformed",
  });
  assert.deepEqual(record.what_changed, { recorded: true, items: ["Safe summary"] });
  assert.deepEqual(record.why, { recorded: false, items: [] });
});
