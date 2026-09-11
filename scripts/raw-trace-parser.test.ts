/**
 * Tests for the raw-output parser — proving it does REAL extraction and stays
 * honest (no fabricated tokens/cost, no hollow results).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseRawOutput } from "../src/lib/raw-trace-parser.ts";
import { normalizeToTrace } from "../src/lib/normalize-trace.ts";
import { computeTraceMetrics } from "../src/lib/trace-metrics.ts";
import { generateBlackboxReport } from "../src/lib/blackbox-report.ts";

const SAMPLE = `Task: fix the failing build
$ npm run build
Error: build failed — TypeScript error in src/config.ts
Reading src/config.ts
$ npm run build
Error: build failed again
Reading src/config.ts
Edited src/config.ts
$ npm run build
Build succeeded
`;

test("extracts commands, reads, edits, and errors as real steps", () => {
  const r = parseRawOutput(SAMPLE);
  assert.equal(r.ok, true);
  assert.ok(r.stepCount >= 3, "should find multiple steps");
  const trace = normalizeToTrace(r.trace);
  // The repeated build command + repeated config read should be present.
  const allCommands = trace.steps.flatMap((s) => s.shellCommands ?? []);
  assert.ok(allCommands.filter((c) => c.includes("npm run build")).length >= 3);
  const reads = trace.steps.flatMap((s) => s.filesRead ?? []);
  assert.ok(reads.filter((f) => f.includes("config.ts")).length >= 2);
});

test("never fabricates token or cost data", () => {
  const r = parseRawOutput(SAMPLE);
  const m = computeTraceMetrics(normalizeToTrace(r.trace));
  assert.equal(m.hasTokenUsage, false);
  assert.equal(m.totalTokens, null);
  assert.equal(m.effectiveCostUsd, null);
});

test("the parsed trace produces a real report with retry/failure findings", async () => {
  const r = parseRawOutput(SAMPLE);
  const report = await generateBlackboxReport(normalizeToTrace(r.trace));
  const types = report.findings.map((f) => f.type);
  assert.ok(types.includes("retry_spiral") || types.includes("repeated_file_read"), `got: ${types.join(", ")}`);
});

test("returns ok:false with guidance when there's no structure", () => {
  const r = parseRawOutput("just some thoughts about my day, nothing technical here");
  assert.equal(r.ok, false);
  assert.equal(r.stepCount, 0);
  assert.match(r.note, /Couldn't find/);
});

test("captures the task summary from a Task: marker", () => {
  const r = parseRawOutput(SAMPLE);
  assert.equal(r.trace?.task_summary, "fix the failing build");
});

// --- Real Claude Code / Cursor markdown transcript --------------------------

const CLAUDE_MD = `## User

Make the auth tests pass.

## Assistant

I'll investigate the failing tests.

⏺ Read(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  Error: 2 tests failed in auth.test.ts

⏺ Edit(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  Error: 1 test failed

⏺ Read(src/lib/auth.ts)
⏺ Edit(src/lib/auth.ts)
⏺ Edit(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  All tests passed

\`\`\`ts
// this code block must NOT be parsed as commands or errors
const error = new Error("ignore me");
\`\`\`
`;

test("parses a Claude Code markdown transcript into many structured steps", () => {
  const r = parseRawOutput(CLAUDE_MD);
  assert.equal(r.ok, true);
  assert.ok(r.stepCount >= 7, `expected many steps, got ${r.stepCount}`);

  const trace = normalizeToTrace(r.trace);
  const commands = trace.steps.flatMap((s) => s.shellCommands ?? []);
  assert.ok(commands.filter((c) => c.includes("npm test")).length >= 3, "should detect repeated npm test");

  const edits = trace.steps.flatMap((s) => s.filesWritten ?? []);
  assert.ok(edits.filter((f) => f.includes("auth.ts")).length >= 3, "should detect repeated edits");

  const reads = trace.steps.flatMap((s) => s.filesRead ?? []);
  assert.ok(reads.filter((f) => f.includes("auth.ts")).length >= 2, "should detect repeated reads");
});

test("captures the task from the first user turn (no Task: marker)", () => {
  const r = parseRawOutput(CLAUDE_MD);
  assert.equal(r.trace?.task_summary, "Make the auth tests pass.");
});

test("does not invent commands/errors from non-shell code fences", () => {
  const r = parseRawOutput(CLAUDE_MD);
  const trace = normalizeToTrace(r.trace);
  const allErrors = trace.steps.flatMap((s) => s.errors ?? []).join(" ");
  assert.ok(!allErrors.includes("ignore me"), "code-fence content must not become an error");
});

test("Claude transcript yields edit-thrash and retry/read findings", async () => {
  const r = parseRawOutput(CLAUDE_MD);
  const report = await generateBlackboxReport(normalizeToTrace(r.trace));
  const types = report.findings.map((f) => f.type);
  assert.ok(types.includes("repeated_file_edit"), `expected edit thrash; got: ${types.join(", ")}`);
  assert.ok(
    types.includes("retry_spiral") || types.includes("repeated_file_read"),
    `expected retry/read finding; got: ${types.join(", ")}`,
  );
});

test("still never fabricates token/cost on a markdown transcript", () => {
  const r = parseRawOutput(CLAUDE_MD);
  const m = computeTraceMetrics(normalizeToTrace(r.trace));
  assert.equal(m.hasTokenUsage, false);
  assert.equal(m.totalTokens, null);
  assert.equal(m.effectiveCostUsd, null);
});
