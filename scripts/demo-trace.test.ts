// Unit tests for the legacy trace fixture retained for parser regression coverage.
//   npm run test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_TRACE,
  DEMO_FINDINGS,
  DEMO_EVIDENCE_GAPS,
  DEMO_PREVENTION_PLAN,
  DEMO_VERDICT,
  DEMO_SAMPLE_NOTICE,
  DEMO_SAMPLE_BADGE,
} from "@/lib/demo-trace";

test("demo data is clearly labelled as a bundled/sample trace", () => {
  assert.match(DEMO_SAMPLE_BADGE.toLowerCase(), /sample/);
  assert.match(DEMO_SAMPLE_NOTICE.toLowerCase(), /bundled/);
  assert.match(DEMO_SAMPLE_NOTICE.toLowerCase(), /sample trace/);
  // The honesty notice must route real submissions to /trace-audit.
  assert.match(DEMO_SAMPLE_NOTICE, /\/trace-audit/);
});
test("report includes findings, each with the required fields", () => {
  assert.ok(DEMO_FINDINGS.length >= 4, "expected several findings");
  const detectors = DEMO_FINDINGS.map((f) => f.detector.toLowerCase()).join(" | ");
  assert.match(detectors, /retry spiral/);
  assert.match(detectors, /bloated tool output/);
  assert.match(detectors, /repeated/);
  assert.match(detectors, /metadata/);
  for (const f of DEMO_FINDINGS) {
    assert.ok(["high", "medium", "low"].includes(f.severity), `${f.id} has a severity`);
    assert.ok(f.verdict.length > 0, `${f.id} has a verdict`);
    assert.ok(f.evidenceSummary.length > 0, `${f.id} has an evidence summary`);
    assert.ok(
      ["Confirmed", "Inferred", "Missing", "Unproven"].includes(f.evidenceLabel),
      `${f.id} has a valid evidence label`,
    );
    assert.ok(f.preventionControl.length > 0, `${f.id} has a prevention control`);
  }
});

test("report includes evidence gaps with honest labels", () => {
  assert.ok(DEMO_EVIDENCE_GAPS.length >= 3);
  const labels = DEMO_EVIDENCE_GAPS.map((g) => g.evidenceLabel);
  assert.ok(labels.includes("Missing") || labels.includes("Unproven"), "gaps flag missing/unproven evidence");
  for (const g of DEMO_EVIDENCE_GAPS) {
    assert.ok(
      ["Confirmed", "Inferred", "Missing", "Unproven"].includes(g.evidenceLabel),
      `${g.label} uses a valid evidence label`,
    );
  }
});

test("prevention plan includes the required controls", () => {
  const plan = DEMO_PREVENTION_PLAN.map((p) => p.control.toLowerCase()).join(" | ");
  assert.match(plan, /cap retries/);
  assert.match(plan, /summarize tool output/);
  assert.match(plan, /model_name.*provider.*tokens.*cost/);
  assert.match(plan, /stop re-reading unchanged files/);
  assert.match(plan, /strategy change after repeated failure/);
});

test("verdict counts are derived from the findings", () => {
  assert.equal(DEMO_VERDICT.findingsCount, DEMO_FINDINGS.length);
  assert.equal(
    DEMO_VERDICT.highSeverityCount,
    DEMO_FINDINGS.filter((f) => f.severity === "high").length,
  );
});

test("input trace carries the messy coding-agent signals", () => {
  const fieldText = DEMO_TRACE.fields.map((f) => `${f.label} ${f.value}`.toLowerCase()).join(" | ");
  assert.match(fieldText, /failed command/);
  assert.match(fieldText, /repeated file read/);
  assert.match(fieldText, /bloated tool output/);
  assert.match(fieldText, /metadata/);
  assert.match(fieldText, /retry count/);
});

