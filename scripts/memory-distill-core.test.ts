import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildIndex, buildSummary, extractClaudeFacts, extractCodexFacts, extractOpenCodeFacts, parseSummary } from "../src/lib/memory-distill-core";
import { drainCaptureSpool, parseClaudeCodeTranscript, rebuildMemoryIndex, spoolPath } from "../src/lib/cross-agent-capture-core";

const line = (o: unknown) => JSON.stringify(o);
const claudeJsonl = [
  line({ type: "user", uuid: "1", message: { content: "Fix the lease bug in relay/lease.ts and run the tests" } }),
  line({ type: "assistant", uuid: "2", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Edit", input: { file_path: "C:\\proj\\relay\\lease.ts", old_string: "SECRET_BODY_DO_NOT_LEAK", new_string: "x" } }] } }),
  line({ type: "assistant", uuid: "3", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test -- --token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nsecond line" } }] } }),
  line({ type: "user", uuid: "4", message: { content: [{ type: "tool_result", content: "TOOL_RESULT_DO_NOT_LEAK" }] } }),
  line({ type: "assistant", uuid: "5", message: { content: [{ type: "text", text: "Fixed the lease renewal race. All 12 tests pass." }] } }),
].join("\n");

test("facts take only file paths and command lines, never bodies or results", () => {
  const facts = extractClaudeFacts(claudeJsonl);
  assert.deepEqual(facts.files, ["C:\\proj\\relay\\lease.ts"]);
  assert.equal(facts.commands.length, 1);
  assert.ok(!JSON.stringify(facts).includes("SECRET_BODY_DO_NOT_LEAK"));
  assert.ok(!JSON.stringify(facts).includes("TOOL_RESULT_DO_NOT_LEAK"));
});

test("summary has goal, relative files, redacted first-line commands and the final message", () => {
  const transcript = parseClaudeCodeTranscript(claudeJsonl);
  const md = buildSummary({ provider: "Claude Code", sessionId: "abc", cwd: "C:\\proj", capturedAtIso: "2026-09-20T10:00:00Z", transcript, facts: extractClaudeFacts(claudeJsonl) });
  assert.match(md, /## Goal\nFix the lease bug in relay\/lease\.ts/);
  assert.match(md, /- relay\/lease\.ts/);
  assert.match(md, /Fixed the lease renewal race/);
  assert.ok(!md.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), "secret in a command must be redacted");
  assert.ok(!md.includes("second line"));
  assert.ok(md.length < 2000);
});

test("summary round-trips into an index line; the index is newest first and small", () => {
  const mk = (id: string, when: string, goal: string, files: string[]) => parseSummary(buildSummary({ provider: "Codex", sessionId: id, cwd: "C:\\p", capturedAtIso: when, transcript: [{ sender: "User", body: goal }, { sender: "Assistant", body: "done" }], facts: { files, commands: [] } }), `local/codex/${id}.summary.md`)!;
  const idx = buildIndex([mk("a", "2026-09-19T00:00:00Z", "older work", ["a.ts"]), mk("b", "2026-09-20T00:00:00Z", "newer work", ["relay/lease.ts", "b.ts", "c.ts", "d.ts", "e.ts"])]);
  assert.ok(idx.indexOf("newer work") < idx.indexOf("older work"));
  assert.match(idx, /\[relay\/lease\.ts, b\.ts, c\.ts, d\.ts \+1\] -> local\/codex\/b\.summary\.md/);
});

test("codex and opencode facts are extracted best effort", () => {
  const codex = line({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "apply_patch <<'EOF'\n*** Update File: src/x.ts\n@@\nEOF"] }) } });
  assert.deepEqual(extractCodexFacts(codex).files, ["src/x.ts"]);
  const oc = { messages: [{ parts: [{ type: "tool", tool: "edit", state: { input: { filePath: "src/y.ts" } } }, { type: "tool", tool: "bash", state: { input: { command: "npm run build" } } }] }] };
  const f = extractOpenCodeFacts(oc);
  assert.deepEqual(f.files, ["src/y.ts"]);
  assert.deepEqual(f.commands, ["npm run build"]);
});

test("draining a spool writes the transcript, the summary beside it, and index.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "m9r-distill-"));
  try {
    const transcriptPath = join(root, "t.jsonl");
    await writeFile(transcriptPath, claudeJsonl);
    await mkdir(join(root, ".oathlock", "capture"), { recursive: true });
    await writeFile(spoolPath(root), JSON.stringify({ provider: "claude-code", sessionId: "sess-1", cwd: root, transcriptPath, reason: "other", capturedAtIso: "2026-09-20T10:00:00Z" }) + "\n");
    const res = await drainCaptureSpool({ repositoryRoot: root, readTranscript: (p) => readFile(p, "utf8"), onLog: () => {} });
    assert.equal(res.drained, 1);
    const dir = join(root, ".oathlock", "memory", "local", "claude-code");
    assert.match(await readFile(join(dir, "sess-1.summary.md"), "utf8"), /## Files changed/);
    const index = await readFile(join(root, ".oathlock", "memory", "index.md"), "utf8");
    assert.match(index, /local\/claude-code\/sess-1\.summary\.md/);
    assert.equal(await rebuildMemoryIndex(root), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a continued session's goal comes from its recap, not the boilerplate opener; older sessions do not pollute the index", () => {
  const md = buildSummary({ provider: "Claude Code", sessionId: "c1", cwd: "C:\p", capturedAtIso: "2026-09-20T08:00:00Z", factsKnown: false,
    transcript: [{ sender: "User", body: "This session is being continued from a previous conversation.\n1. Primary Request and Intent:\n   - Build the native front door for M9R" }, { sender: "Assistant", body: "Continuing." }], facts: { files: [], commands: [] } });
  assert.match(md, /## Goal\n\(continued\) .*Build the native front door/);
  assert.match(md, /^- When: 2026-09-20T08:00:00Z$/m);
  const entry = parseSummary(md, "local/claude-code/c1.summary.md")!;
  assert.deepEqual(entry.files, []);
});
