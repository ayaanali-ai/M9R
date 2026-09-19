import assert from "node:assert/strict";
import test from "node:test";
import { nativeResumeCommand } from "@/lib/native-resume-command";

test("resume commands use each provider's own CLI syntax", () => {
  assert.equal(nativeResumeCommand("claude-code", "abc-123"), "claude --resume abc-123");
  assert.equal(nativeResumeCommand("codex", "019a-uuid"), "codex resume 019a-uuid");
  assert.equal(nativeResumeCommand("opencode", "ses_f4dc3cac"), "opencode --session ses_f4dc3cac");
});

test("no command for unknown providers, missing ids, or ids that could inject shell text", () => {
  assert.equal(nativeResumeCommand("grok-build", "abc"), null);
  assert.equal(nativeResumeCommand("codex", null), null);
  assert.equal(nativeResumeCommand("codex", "a; rm -rf /"), null);
  assert.equal(nativeResumeCommand("codex", "a b"), null);
});
