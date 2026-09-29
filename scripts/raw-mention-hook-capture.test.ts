import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { armRawMentionHookCapture, captureArmedRawMentionPayloadOnce } from "@/lib/native/hook-run";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "m9r-raw-hook-capture-"));
}

test("raw mention capture preserves the exact hook wire once, only after an opted-in routed Claude mention", (t) => {
  const root = temporaryRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rawPayload = '{  "hook_event_name":"UserPromptSubmit", "session_id":"s1", "prompt":"@codex test"  }\r\n';
  assert.equal(armRawMentionHookCapture(root), true);
  assert.equal(captureArmedRawMentionPayloadOnce(root, "codex", ["codex"], rawPayload), false);
  assert.equal(captureArmedRawMentionPayloadOnce(root, "claude-code", [], rawPayload), false);
  assert.equal(captureArmedRawMentionPayloadOnce(root, "claude-code", ["codex"], rawPayload), true);

  const path = join(root, "diagnostics", "mention-hook-payloads.jsonl");
  const rows = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  const record = JSON.parse(rows[0]) as { provider: string; targets: string[]; rawPayload: string };
  assert.equal(record.provider, "claude-code");
  assert.deepEqual(record.targets, ["codex"]);
  assert.equal(record.rawPayload, rawPayload);
  assert.equal(existsSync(join(root, "diagnostics", "capture-next-raw-mention")), false);
  assert.equal(captureArmedRawMentionPayloadOnce(root, "claude-code", ["codex"], rawPayload), false);
});

test("raw mention capture refuses oversized payloads and log growth beyond its fixed cap", (t) => {
  const root = temporaryRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(armRawMentionHookCapture(root), true);
  assert.equal(captureArmedRawMentionPayloadOnce(root, "claude-code", ["codex"], "x".repeat(70 * 1024)), false);
  assert.equal(existsSync(join(root, "diagnostics", "mention-hook-payloads.jsonl")), false);

  const logPath = join(root, "diagnostics", "mention-hook-payloads.jsonl");
  mkdirSync(join(root, "diagnostics"), { recursive: true });
  writeFileSync(logPath, "x".repeat(4 * 1024 * 1024));
  assert.equal(armRawMentionHookCapture(root), true);
  assert.equal(captureArmedRawMentionPayloadOnce(root, "claude-code", ["codex"], "small"), false);
  assert.equal(existsSync(join(root, "diagnostics", "capture-next-raw-mention")), false);
});
