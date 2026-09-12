import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSpoolLine,
  parseClaudeCodeTranscript,
  parseCodexTranscript,
  normalizeOpenCodeExport,
  extractTranscript,
  renderCaptureMarkdown,
  captureMemoryPath,
  drainCaptureSpool,
  spoolPath,
  type CaptureJob,
} from "../src/lib/cross-agent-capture-core.ts";

// ---------------------------------------------------------------------------
// parseSpoolLine
// ---------------------------------------------------------------------------

test("parseSpoolLine parses a well-formed claude-code/codex job", () => {
  const line = JSON.stringify({
    provider: "codex",
    sessionId: "thr_123",
    transcriptPath: "/workspace/.codex/rollout.jsonl",
    cwd: "/workspace",
    reason: "other",
    capturedAtIso: "2026-09-12T00:00:00.000Z",
  });
  const job = parseSpoolLine(line);
  assert.ok(job && job.provider === "codex");
  if (job?.provider === "codex") assert.equal(job.transcriptPath, "/workspace/.codex/rollout.jsonl");
});

test("parseSpoolLine parses a well-formed opencode job with an embedded export", () => {
  const line = JSON.stringify({
    provider: "opencode",
    sessionId: "ses_abc",
    cwd: "/workspace",
    capturedAtIso: "2026-09-12T00:00:00.000Z",
    export: { messages: [] },
  });
  const job = parseSpoolLine(line);
  assert.ok(job && job.provider === "opencode");
});

test("parseSpoolLine returns null for blank lines, invalid JSON, unknown provider, and missing required fields", () => {
  assert.equal(parseSpoolLine(""), null);
  assert.equal(parseSpoolLine("   "), null);
  assert.equal(parseSpoolLine("{not json"), null);
  assert.equal(parseSpoolLine(JSON.stringify({ provider: "cursor", sessionId: "x", cwd: "/", capturedAtIso: "t" })), null);
  assert.equal(parseSpoolLine(JSON.stringify({ provider: "codex", cwd: "/", capturedAtIso: "t" })), null, "missing sessionId");
  assert.equal(
    parseSpoolLine(JSON.stringify({ provider: "codex", sessionId: "x", cwd: "/", capturedAtIso: "t" })),
    null,
    "missing transcriptPath for a non-opencode provider",
  );
});

// ---------------------------------------------------------------------------
// parseClaudeCodeTranscript
// ---------------------------------------------------------------------------

test("parseClaudeCodeTranscript extracts user/assistant text and tool-use names, skips other record types", () => {
  const lines = [
    JSON.stringify({ type: "summary", uuid: "s1" }),
    JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "fix the bug" } }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Looking into it." },
          { type: "tool_use", name: "read_file" },
          { type: "tool_result" },
        ],
      },
    }),
  ].join("\n");

  const messages = parseClaudeCodeTranscript(lines);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { sender: "User", body: "fix the bug" });
  assert.equal(messages[1].sender, "Assistant");
  assert.match(messages[1].body, /Looking into it\./);
  assert.match(messages[1].body, /\[used tool: read_file\]/);
  assert.match(messages[1].body, /\[tool result omitted\]/);
});

test("parseClaudeCodeTranscript dedupes on uuid, last write wins (resume/rewind rewrite)", () => {
  const lines = [
    JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "first draft" } }),
    JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "rewritten after rewind" } }),
  ].join("\n");
  const messages = parseClaudeCodeTranscript(lines);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "rewritten after rewind");
});

test("parseClaudeCodeTranscript never throws on malformed lines", () => {
  const lines = ["not json at all", "{}", JSON.stringify({ type: "user" }), ""].join("\n");
  assert.deepEqual(parseClaudeCodeTranscript(lines), []);
});

// ---------------------------------------------------------------------------
// parseCodexTranscript
// ---------------------------------------------------------------------------

test("parseCodexTranscript extracts role/content from a payload-shaped record", () => {
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: "thr_1" } }),
    JSON.stringify({ type: "response_item", payload: { role: "user", content: "what does this function do" } }),
    JSON.stringify({ type: "response_item", payload: { role: "assistant", content: [{ text: "It parses the config." }] } }),
  ].join("\n");
  const messages = parseCodexTranscript(lines);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { sender: "User", body: "what does this function do" });
  assert.deepEqual(messages[1], { sender: "Assistant", body: "It parses the config." });
});

test("parseCodexTranscript never throws on malformed or unrecognized lines", () => {
  const lines = ["garbage", JSON.stringify({ type: "turn_context" }), JSON.stringify({ payload: { role: "system", content: "x" } })].join("\n");
  assert.deepEqual(parseCodexTranscript(lines), []);
});

// ---------------------------------------------------------------------------
// normalizeOpenCodeExport
// ---------------------------------------------------------------------------

test("normalizeOpenCodeExport extracts text and tool parts from the { info, messages: [{ info, parts }] } shape", () => {
  const raw = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "add a test" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Added one." },
          { type: "tool", tool: "write_file" },
        ],
      },
    ],
  };
  const messages = normalizeOpenCodeExport(raw);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { sender: "User", body: "add a test" });
  assert.match(messages[1].body, /Added one\./);
  assert.match(messages[1].body, /\[used tool: write_file\]/);
});

test("normalizeOpenCodeExport tolerates garbage input", () => {
  assert.deepEqual(normalizeOpenCodeExport(null), []);
  assert.deepEqual(normalizeOpenCodeExport("not an object"), []);
  assert.deepEqual(normalizeOpenCodeExport({}), []);
});

// ---------------------------------------------------------------------------
// renderCaptureMarkdown — redaction wiring
// ---------------------------------------------------------------------------

test("renderCaptureMarkdown redacts secrets and records a redaction count", () => {
  const job: CaptureJob = {
    provider: "codex",
    sessionId: "thr_secret",
    transcriptPath: "/x",
    cwd: "/workspace",
    reason: "other",
    capturedAtIso: "2026-09-12T00:00:00.000Z",
  };
  const transcript = [{ sender: "User", body: "here is my key sk-ant-abcdefghijklmnopqrstuvwx" }];
  const markdown = renderCaptureMarkdown(job, transcript);
  assert.ok(!markdown.includes("sk-ant-abcdefghijklmnopqrstuvwx"), "the raw secret must never reach the written file");
  assert.match(markdown, /\[REDACTED:ANTHROPIC_KEY\]/);
  assert.match(markdown, /Redacted: 1 item/);
});

test("renderCaptureMarkdown handles an empty transcript honestly", () => {
  const job: CaptureJob = { provider: "opencode", sessionId: "ses_empty", cwd: "/workspace", capturedAtIso: "t", export: { messages: [] } };
  const markdown = renderCaptureMarkdown(job, []);
  assert.match(markdown, /no message content could be extracted/);
});

// ---------------------------------------------------------------------------
// extractTranscript dispatch
// ---------------------------------------------------------------------------

test("extractTranscript dispatches by provider and never throws on bad input", () => {
  const opencodeJob: CaptureJob = { provider: "opencode", sessionId: "s", cwd: "/", capturedAtIso: "t", export: { messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }] } };
  assert.deepEqual(extractTranscript(opencodeJob, null), [{ sender: "User", body: "hi" }]);

  const claudeJob: CaptureJob = { provider: "claude-code", sessionId: "s", transcriptPath: "/x", cwd: "/", reason: "other", capturedAtIso: "t" };
  assert.deepEqual(extractTranscript(claudeJob, "not valid jsonl at all"), []);
  assert.deepEqual(extractTranscript(claudeJob, null), []);
});

// ---------------------------------------------------------------------------
// captureMemoryPath
// ---------------------------------------------------------------------------

test("captureMemoryPath files a captured session under memory/local/<provider>, separate from dashboard sessions", () => {
  const job: CaptureJob = { provider: "opencode", sessionId: "ses_1", cwd: "/workspace", capturedAtIso: "t", export: {} };
  const path = captureMemoryPath("/repo", job);
  assert.equal(path, join("/repo", ".oathlock", "memory", "local", "opencode", "ses_1.md"));
});

// ---------------------------------------------------------------------------
// drainCaptureSpool — real temp-directory integration
// ---------------------------------------------------------------------------

test("drainCaptureSpool reads pending jobs, writes redacted markdown, and clears the spool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-capture-"));
  try {
    const spool = spoolPath(dir);
    await mkdir(join(dir, ".oathlock", "capture"), { recursive: true });
    const job = { provider: "codex", sessionId: "thr_drain", transcriptPath: "/fake/rollout.jsonl", cwd: dir, reason: "other", capturedAtIso: "2026-09-12T00:00:00.000Z" };
    await writeFile(spool, JSON.stringify(job) + "\n", "utf8");

    const transcriptJsonl = [JSON.stringify({ type: "response_item", payload: { role: "user", content: "hello AKIAABCDEFGHIJKLMNOP" } })].join("\n");
    const result = await drainCaptureSpool({
      repositoryRoot: dir,
      readTranscript: async (path) => {
        assert.equal(path, "/fake/rollout.jsonl");
        return transcriptJsonl;
      },
    });

    assert.equal(result.drained, 1);
    assert.equal(result.failed, 0);

    const written = await readFile(join(dir, ".oathlock", "memory", "local", "codex", "thr_drain.md"), "utf8");
    assert.match(written, /# Codex session/);
    assert.ok(!written.includes("AKIAABCDEFGHIJKLMNOP"));
    assert.match(written, /\[REDACTED:AWS_ACCESS_KEY\]/);

    const spoolAfter = await readFile(spool, "utf8");
    assert.equal(spoolAfter.trim(), "", "spool must be cleared once every job has been attempted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drainCaptureSpool is a no-op when there is no spool file yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-capture-empty-"));
  try {
    const result = await drainCaptureSpool({ repositoryRoot: dir, readTranscript: async () => "" });
    assert.deepEqual(result, { drained: 0, failed: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drainCaptureSpool records a failure and clears its line when a transcript can't be read, without crashing the batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-capture-fail-"));
  try {
    const spool = spoolPath(dir);
    await mkdir(join(dir, ".oathlock", "capture"), { recursive: true });
    const okJob = { provider: "codex", sessionId: "thr_ok", transcriptPath: "/ok.jsonl", cwd: dir, reason: "other", capturedAtIso: "t" };
    const badJob = { provider: "codex", sessionId: "thr_bad", transcriptPath: "/missing.jsonl", cwd: dir, reason: "other", capturedAtIso: "t" };
    await writeFile(spool, `${JSON.stringify(badJob)}\n${JSON.stringify(okJob)}\n`, "utf8");

    const result = await drainCaptureSpool({
      repositoryRoot: dir,
      readTranscript: async (path) => {
        if (path === "/missing.jsonl") throw new Error("ENOENT");
        return "";
      },
    });

    assert.equal(result.drained, 1, "the second, readable job must still succeed");
    assert.equal(result.failed, 1);
    const errorLog = await readFile(join(dir, ".oathlock", "capture", "errors.log"), "utf8");
    assert.match(errorLog, /thr_bad/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
