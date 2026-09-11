// Smoke tests for the bundled self-serve /trace-audit sample traces. Run with:
//   npm run test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_SAMPLE_TRACES } from "@/lib/demo-sample-traces";
import { buildBlackboxReport } from "@/lib/browser-trace-analysis";
import type { OathlockTrace } from "@/lib/oathlock-trace-adapter";

test("the four required sample formats are present", () => {
  const ids = DEMO_SAMPLE_TRACES.map((t) => t.id);
  for (const id of ["oathlock", "generic", "claude-code", "otel"]) {
    assert.ok(ids.includes(id), `missing sample: ${id}`);
  }
});

test("every sample produces a non-throwing Blackbox Report", () => {
  for (const t of DEMO_SAMPLE_TRACES) {
    const report = buildBlackboxReport(t.data);
    assert.ok(report.runSummary.steps > 0, `${t.id} has steps`);
    assert.ok(typeof report.failureType === "string", `${t.id} has a failure type`);
  }
});

test("the OathLock sample totals equal the sum of per-step usage", () => {
  const sample = DEMO_SAMPLE_TRACES.find((t) => t.id === "oathlock");
  assert.ok(sample, "oathlock sample exists");
  const trace = sample!.data as OathlockTrace;

  const sumInput = trace.steps.reduce((a, s) => a + (s.token_usage?.input ?? 0), 0);
  const sumOutput = trace.steps.reduce((a, s) => a + (s.token_usage?.output ?? 0), 0);
  const sumTotal = trace.steps.reduce((a, s) => a + (s.token_usage?.total ?? 0), 0);
  const sumCost = trace.steps.reduce((a, s) => a + (s.estimated_cost_usd ?? 0), 0);

  const totals = trace.totals.token_usage;
  assert.ok(totals, "sample carries token_usage totals");
  assert.equal(totals!.input, sumInput, "input total reconciled");
  assert.equal(totals!.output, sumOutput, "output total reconciled");
  assert.equal(totals!.total, sumTotal, "token total reconciled");
  // Each per-step total must equal its own input + output.
  for (const s of trace.steps) {
    if (s.token_usage?.input != null && s.token_usage.output != null) {
      assert.equal(
        s.token_usage.total,
        s.token_usage.input + s.token_usage.output,
        `step ${s.step} total == input + output`,
      );
    }
  }
  // Cost total reconciled (allow float tolerance).
  assert.ok(
    Math.abs((trace.totals.estimated_cost_usd ?? 0) - sumCost) < 1e-9,
    "estimated cost total reconciled",
  );
});

test("samples without usage metadata report waste as unknown, not invented", () => {
  const generic = DEMO_SAMPLE_TRACES.find((t) => t.id === "generic")!;
  const report = buildBlackboxReport(generic.data);
  assert.equal(report.tokenWaste.known, false);
  assert.equal(report.tokenWaste.tokens, null);
});
