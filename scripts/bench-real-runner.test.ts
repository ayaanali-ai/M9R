import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeJson } from "./bench/claude-cli";
import { reportFrom, totalsOf } from "./bench/real-runner";

test("usage and cost are read from Claude Code's json output, and missing fields count as zero", () => {
  const json = parseClaudeJson(
    JSON.stringify({ result: "UU35D3", is_error: false, num_turns: 3, total_cost_usd: 0.0384, usage: { input_tokens: 6, output_tokens: 342, cache_creation_input_tokens: 7972, cache_read_input_tokens: 15415 } }),
  );
  const report = reportFrom("a1", 0, false, json, "");
  assert.deepEqual(
    { turns: report.turns, cost: report.costUsd, input: report.inputTokens, output: report.outputTokens, created: report.cacheCreationTokens, read: report.cacheReadTokens, error: report.error },
    { turns: 3, cost: 0.0384, input: 6, output: 342, created: 7972, read: 15415, error: undefined },
  );
  const bare = reportFrom("a2", 0, false, parseClaudeJson('{"result":"ok"}'), "");
  assert.equal(bare.costUsd, 0);
  assert.equal(bare.turns, 0);
});

test("a killed agent is flagged as missing its usage instead of silently counting as free", () => {
  const report = reportFrom("a3", null, true, null, "");
  assert.equal(report.killed, true);
  assert.match(report.error ?? "", /usage is missing/);
});

test("an agent that reports an error keeps the message, and unparseable output surfaces stderr", () => {
  assert.equal(reportFrom("a1", 1, false, parseClaudeJson('{"is_error":true,"result":"budget exceeded"}'), "").error, "budget exceeded");
  assert.equal(reportFrom("a1", 1, false, parseClaudeJson("not json"), "boom").error, "boom");
  assert.equal(parseClaudeJson("not json"), null);
});

test("totals add every agent's turns, cost and all four token counts", () => {
  const a = reportFrom("a1", 0, false, parseClaudeJson(JSON.stringify({ num_turns: 2, total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } })), "");
  const b = reportFrom("a2", 0, false, parseClaudeJson(JSON.stringify({ num_turns: 5, total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } })), "");
  const totals = totalsOf([a, b]);
  assert.equal(totals.turns, 7);
  assert.ok(Math.abs(totals.costUsd - 0.35) < 1e-9);
  assert.equal(totals.tokens, 1 + 2 + 3 + 4 + 10 + 20 + 30 + 40);
});
