import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexArgs, codexAsClaudeJson, usageFromJsonl } from "./bench/codex-cli";
import { reportFrom, totalsOf } from "./bench/real-runner";

const events = [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  "not json, a CLI diagnostic line",
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 20 } }),
].join("\n");

test("Codex usage is summed over turns and ignores non-event lines", () => {
  assert.deepEqual(usageFromJsonl(events), { input: 1200, cached: 400, output: 70 });
  assert.equal(usageFromJsonl("nothing structured here"), null);
});

test("a Codex run is reported like a Claude one: cached tokens split out, no dollar cost, final message kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "m9r-codex-cli-test-"));
  try {
    const path = join(dir, "last.txt");
    writeFileSync(path, "  UU35D3  \n");
    const json = codexAsClaudeJson(events, 0, path);
    assert.equal(json?.result, "UU35D3");
    assert.equal(json?.total_cost_usd, 0);
    assert.deepEqual(json?.usage, { input_tokens: 800, output_tokens: 70, cache_creation_input_tokens: 0, cache_read_input_tokens: 400 });
    const report = reportFrom("a2", 0, false, json, "", "codex");
    assert.equal(report.vendor, "codex");
    assert.equal(report.error, undefined);
    assert.equal(totalsOf([report]).tokens, 800 + 70 + 400, "cached tokens count once");
    assert.equal(codexAsClaudeJson("", 1, join(dir, "missing.txt")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex is launched read-only, ephemeral, with web search off, only the M9R server, and its tools pre-approved", () => {
  const args = codexArgs({ prompt: "p", cwd: "C:/scratch", launcher: "C:/l/launch-m9r-mcp.cjs", storeRoot: "C:/store", brokerPort: 4242, lastMessagePath: "C:/scratch/last.txt" });
  assert.deepEqual(args.slice(0, 2), ["exec", "p"]);
  for (const flag of ["--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--json"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes('web_search="disabled"'));
  const mcp = args[args.indexOf("-c") + 1];
  assert.match(mcp, /^mcp_servers=\{m9r=\{/);
  assert.match(mcp, /default_tools_approval_mode="approve"/);
  assert.match(mcp, /M9R_WEB_BROKER_PORT="4242"/);
  assert.ok(!args.includes("--model"), "no model flag unless asked for");
  assert.ok(codexArgs({ prompt: "p", cwd: "c", launcher: "l", storeRoot: "s", brokerPort: 1, lastMessagePath: "x", model: "gpt-x" }).includes("gpt-x"));
});
