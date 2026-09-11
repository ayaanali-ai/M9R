// Regression tests for the OathLock sample-trace fixtures and the detector
// adapter. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseTraceJson,
  parseTraceJsonl,
  analyzeOathlockTrace,
  toNormalizedManualTrace,
  expectationFired,
} from "@/lib/oathlock-trace-adapter";

const dir = resolve(process.cwd(), "examples/sample-traces");
const read = (f: string) => readFileSync(resolve(dir, f), "utf8");

const clean = parseTraceJson(read("oathlock-clean-coding-agent.json"));
const messy = parseTraceJson(read("oathlock-messy-coding-agent.json"));
const cleanFindings = analyzeOathlockTrace(clean);
const messyFindings = analyzeOathlockTrace(messy);

test("messy trace triggers repeated_context", () => {
  assert.ok(expectationFired(messyFindings, "repeated_context"));
});

test("messy trace triggers bloated_tool_output", () => {
  assert.ok(expectationFired(messyFindings, "bloated_tool_output"));
});

test("messy trace triggers retry_spiral", () => {
  assert.ok(expectationFired(messyFindings, "retry_spiral"));
});

test("messy trace triggers missing_usage_metadata", () => {
  assert.ok(expectationFired(messyFindings, "missing_usage_metadata"));
});

test("model_overkill does not fire (no model-tier mismatch in the trace)", () => {
  assert.equal(expectationFired(messyFindings, "model_overkill"), false);
  assert.equal(expectationFired(cleanFindings, "model_overkill"), false);
});

test("clean trace produces materially fewer findings than messy", () => {
  assert.ok(
    cleanFindings.length < messyFindings.length,
    `clean ${cleanFindings.length} should be < messy ${messyFindings.length}`,
  );
  // Clean must not trip the messy-specific detectors.
  for (const e of ["repeated_context", "bloated_tool_output", "missing_usage_metadata"] as const) {
    assert.equal(expectationFired(cleanFindings, e), false, `clean should not fire ${e}`);
  }
});

test("JSON and JSONL traces parse and yield identical findings", () => {
  for (const variant of ["clean", "messy"] as const) {
    const j = parseTraceJson(read(`oathlock-${variant}-coding-agent.json`));
    const l = parseTraceJsonl(read(`oathlock-${variant}-coding-agent.jsonl`));
    assert.equal(l.steps.length, j.steps.length);
    assert.equal(l.session_id, j.session_id);
    assert.deepEqual(
      analyzeOathlockTrace(l).map((f) => f.type).sort(),
      analyzeOathlockTrace(j).map((f) => f.type).sort(),
    );
  }
});

test("no detector claims unavailable token/cost/model as confirmed when null", () => {
  // Messy trace reports no usage -> normalized exact_* stay null, and the
  // missing_usage_metadata detector fires honestly instead of inventing numbers.
  const nm = toNormalizedManualTrace(messy);
  assert.equal(nm.exact_token_count, null);
  assert.equal(nm.exact_cost_usd, null);
  assert.equal(nm.exact_model_calls, null);
  assert.ok(expectationFired(messyFindings, "missing_usage_metadata"));

  // Clean trace has measured usage -> exact_* are populated and the
  // missing-usage detector stays silent. Confirmed only when truly present.
  const nc = toNormalizedManualTrace(clean);
  assert.equal(typeof nc.exact_token_count, "number");
  assert.equal(typeof nc.exact_cost_usd, "number");
  assert.equal(typeof nc.exact_model_calls, "number");
  assert.equal(expectationFired(cleanFindings, "missing_usage_metadata"), false);
});
