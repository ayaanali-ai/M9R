import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTokenEfficiency, summarizeFindingReuse, summarizeCoordinationCost } from "../src/lib/efficiency-metrics.ts";
import { createTaskEfficiencyReport, intervalUnionMs } from "../src/lib/native/task-efficiency-report";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Task } from "../src/lib/native/inbox-core";

const from = "2026-11-16T17:38:00Z", to = "2026-11-16T17:39:00Z";
const at = (seconds: number) => new Date(Date.parse(from) + seconds * 1000).toISOString();
const add = (report: ReturnType<typeof createTaskEfficiencyReport>, seconds: number, row: Record<string, unknown>) => report.addLine(JSON.stringify({ timestamp: at(seconds), ...row }));

test("transcript usage deduplicates streaming message snapshots, uses latest corrections and preserves missing coverage", () => {
  const report = createTaskEfficiencyReport({ format: "claude", from, to });
  add(report, 1, { message: { id: "one", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 } } });
  add(report, 2, { message: { id: "one", usage: { input_tokens: 9, output_tokens: 30 } } });
  add(report, 3, { message: { id: "two", usage: { input_tokens: 5 } } });
  add(report, 4, { message: { usage: { input_tokens: 99999 } } });
  add(report, 70, { message: { id: "outside", usage: { input_tokens: 99999 } } });
  report.addLine("bad json");
  const result = report.finish();
  assert.equal(result.usage.counters.inputTokens, 14); assert.equal(result.usage.counters.outputTokens, 30);
  assert.equal(result.usage.counters.cachedInputTokens, 100); assert.equal(result.usage.counters.cacheWriteInputTokens, null);
  assert.equal(result.usage.usageUnits, 2); assert.equal(result.usage.knownSamples.outputTokens, 1);
  assert.equal(result.usage.anonymousUsageRecords, 1); assert.equal(result.parsing.malformedLines, 1);
  assert.equal(result.cost.subscriptionAllowancePercent, null); assert.equal(result.cost.apiEstimateUsd, null);
  assert.deepEqual(report.finish(), result, "report generation is idempotent");
});

test("payloads distinguish decoded images from text and correlate tool wait without treating repeats as proven waste", () => {
  const report = createTaskEfficiencyReport({ format: "claude", from, to });
  const call = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "m9r_computer_observe", input: { operationId: "repeat", secret: "DO_NOT_EXPORT" } }] } });
  add(report, 1, call("a")); add(report, 1, call("a")); add(report, 2, call("b"));
  add(report, 4, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: false,
    content: [{ type: "text", text: '{"ok":true}' }, { type: "image", source: { type: "base64", data: "eA==" } }] }] } });
  add(report, 5, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: "OUTPUT TRUNCATED DO_NOT_EXPORT" }] } });
  const result = report.finish();
  assert.equal(result.tools.observedCalls, 2); assert.equal(result.tools.repeatedArguments, 1); assert.equal(result.tools.repeatedOperationIds, 1);
  assert.equal(result.tools.byTool.m9r_computer_observe.imageDecodedBytes, 1);
  assert.equal(result.tools.byTool.m9r_computer_observe.imageBlocks, 1);
  assert.equal(result.timing.toolWaitUnionMs, 4000, "overlapping tool waits are unioned, not summed");
  assert.equal(result.tools.typedFailedResults, 1); assert.equal(result.tools.truncationNotices, 1);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPORT|eA==/);
  assert.equal(result.outcomes.ownerInterventions, null);
});

test("Codex cumulative usage is differenced once; duplicate last-usage records, resets and unknown boundaries are not billed", () => {
  const report = createTaskEfficiencyReport({ format: "codex", from, to });
  const sample = (input: number, output: number) => ({ type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, cache_write_input_tokens: 0 }, last_token_usage: { input_tokens: 99999 } } } });
  add(report, -1, sample(100, 10)); add(report, 5, sample(150, 20)); add(report, 5, sample(150, 20));
  add(report, 6, { type: "token_usage_record", input_tokens: 99999 });
  add(report, 10, sample(170, 30)); add(report, 15, sample(3, 1)); add(report, 20, sample(8, 2));
  const result = report.finish();
  assert.equal(result.usage.counters.inputTokens, 75); assert.equal(result.usage.counters.outputTokens, 21);
  assert.equal(result.usage.counterResets, 1); assert.equal(result.usage.boundarySpanningSamples, 1);
  assert.equal(result.cost.apiEstimateUsd, null);
  const noBaseline = createTaskEfficiencyReport({ format: "codex", from, to });
  add(noBaseline, 5, sample(100, 10));
  assert.equal(noBaseline.finish().usage.counters.inputTokens, null, "first cumulative total is not assumed to belong to the selected window");
});

test("Codex nested MCP image payloads are not counted as plain base64 text", () => {
  const report = createTaskEfficiencyReport({ format: "codex", from, to });
  add(report, 1, { type: "response_item", payload: { type: "function_call", call_id: "a", name: "m9r_observe", arguments: "{}" } });
  add(report, 2, { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: JSON.stringify({ content: [
    { type: "text", text: "Hello" }, { type: "image", data: Buffer.alloc(1000).toString("base64") }] }) } });
  const result = report.finish();
  assert.ok(result.tools.byTool.m9r_observe.textBytes < 30);
  assert.equal(result.tools.byTool.m9r_observe.imageDecodedBytes, 1000);
  assert.equal(result.tools.unknownResults, 1, "untyped output is not silently called success");
  add(report, 3, { type: "response_item", payload: { type: "function_call", call_id: "b", name: "m9r_observe", arguments: "{}" } });
  add(report, 4, { type: "response_item", payload: { type: "function_call_output", call_id: "b", output: JSON.stringify({ content: [{ type: "image" }] }) } });
  assert.equal(report.finish().tools.byTool.m9r_observe.imageDecodedBytes, null, "missing image bytes are not assumed zero");
});

test("stage evidence overlaps tool waits and missing/truncated state never becomes proven reasoning or artifact success", () => {
  const task = { id: "T1", receipt: { state: "completed" }, completion: { status: "completed" }, stageTiming: [
    { phase: "action", startedAt: at(1), endedAt: at(6), durationMs: 5000, status: "ok" },
    { phase: "input-dispatch", startedAt: at(2), endedAt: at(3), durationMs: 1000, status: "ok" }],
    stageTimingSummary: { action: { count: 8 } } } as unknown as Task;
  const report = createTaskEfficiencyReport({ format: "claude", from, to, tasks: [task], taskIds: ["T1", "T2"] });
  add(report, 2, { message: { content: [{ type: "tool_use", id: "a", name: "act", input: {} }] } });
  add(report, 4, { message: { content: [{ type: "tool_result", tool_use_id: "a", content: "done" }] } });
  const result = report.finish();
  assert.equal(result.timing.topStageUnionMs, 5000); assert.equal(result.timing.unattributedWallMs, 55000);
  assert.equal(result.outcomes.artifactCorrect, null); assert.equal(result.outcomes.taskReports[0].rawTimingMayBeIncomplete, true);
  assert.deepEqual(result.outcomes.missingTaskIds, ["T2"]);
  assert.equal(intervalUnionMs([[-500, -200], [-300, 100]], -1000, 1000), 600);
});

test("only explicit complete API rates and explicit review produce estimates or correctness, never subscription allowance", () => {
  const report = createTaskEfficiencyReport({ format: "claude", from, to,
    rates: { inputAccounting: "exclusive", inputUsdPerMillion: 2, outputUsdPerMillion: 4, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 3 },
    review: { artifactCorrect: false, ownerInterventions: 2, evidence: "Owner-reviewed saved artifact" } });
  add(report, 1, { message: { id: "one", usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 } } });
  const result = report.finish(); assert.equal(result.cost.apiEstimateUsd, 0.01);
  assert.equal(result.cost.subscriptionAllowancePercent, null); assert.equal(result.outcomes.artifactCorrect, false);
  assert.equal(result.outcomes.ownerInterventions, 2);
  assert.throws(() => createTaskEfficiencyReport({ format: "claude", from, to, review: null as never }));
  assert.throws(() => createTaskEfficiencyReport({ format: "claude", from, to, rates: null as never }));
});

test("the report command analyzes a local fixture end to end and refuses overwriting evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-efficiency-"));
  try {
    const transcript = join(root, "record.jsonl"), output = join(root, "report.json");
    const source = JSON.stringify({ timestamp: at(1), message: { id: "one", usage: { input_tokens: 7 } } }) + "\n";
    writeFileSync(transcript, source);
    const args = ["--import", "./scripts/register-alias.mjs", "./scripts/task-efficiency-report.ts", "--format", "claude", "--transcript", transcript, "--from", from, "--to", to, "--out"];
    const result = spawnSync(process.execPath, [...args, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).usage.counters.inputTokens, 7);
    assert.equal(spawnSync(process.execPath, [...args, transcript], { encoding: "utf8" }).status, 1);
    assert.equal(readFileSync(transcript, "utf8"), source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("token efficiency averages only known-token runs, never fills gaps with 0", () => {
  const report = summarizeTokenEfficiency([
    { mode: "solo", knownTokens: 100 },
    { mode: "solo", knownTokens: null },
    { mode: "coordinated", knownTokens: 200 },
  ]);
  assert.equal(report.byMode.solo.runCount, 2);
  assert.equal(report.byMode.solo.knownTokenRuns, 1);
  assert.equal(report.byMode.solo.averageKnownTokens, 100);
  assert.equal(report.byMode.coordinated.averageKnownTokens, 200);
  assert.equal(report.byMode.assurance.averageKnownTokens, null);
});

test("unknownTokenCoverage reflects the real share of unknown runs", () => {
  const report = summarizeTokenEfficiency([
    { mode: "solo", knownTokens: 100 },
    { mode: "solo", knownTokens: null },
    { mode: "solo", knownTokens: null },
    { mode: "solo", knownTokens: null },
  ]);
  assert.equal(report.unknownTokenCoverage, 0.75);
});

test("empty input reports zero runs and zero unknown coverage, not NaN", () => {
  const report = summarizeTokenEfficiency([]);
  assert.equal(report.totalRuns, 0);
  assert.equal(report.unknownTokenCoverage, 0);
  assert.equal(report.byMode.solo.averageKnownTokens, null);
});

test("finding reuse rate is null (not 0) when there are no available findings", () => {
  const report = summarizeFindingReuse([]);
  assert.equal(report.reuseRate, null);
  assert.equal(report.totalAvailable, 0);
});

test("finding reuse rate counts findings with at least one adoption", () => {
  const report = summarizeFindingReuse([{ adoptedCount: 2 }, { adoptedCount: 0 }, { adoptedCount: 1 }, { adoptedCount: 0 }]);
  assert.equal(report.totalAvailable, 4);
  assert.equal(report.adoptedCount, 2);
  assert.equal(report.reuseRate, 0.5);
});

test("coordination cost flags runs where requests were issued but never resolved", () => {
  const report = summarizeCoordinationCost([
    { mode: "solo", requestsIssued: 0, requestsResolved: 0 },
    { mode: "coordinated", requestsIssued: 2, requestsResolved: 2 },
    { mode: "assurance", requestsIssued: 1, requestsResolved: 0 },
  ]);
  assert.equal(report.coordinatedOrAssuranceRuns, 2);
  assert.equal(report.unresolvedCoordinationRuns, 1);
});

test("solo runs never count as coordinating even if requestsIssued is somehow nonzero", () => {
  const report = summarizeCoordinationCost([{ mode: "solo", requestsIssued: 1, requestsResolved: 0 }]);
  assert.equal(report.coordinatedOrAssuranceRuns, 0);
});
