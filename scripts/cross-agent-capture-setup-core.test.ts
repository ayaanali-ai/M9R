import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeClaudeCodeLocalSettings,
  mergeCodexHooks,
  buildOpenCodeMemoryPlugin,
  CAPTURE_HOOK_SCRIPT_SOURCE,
  CAPTURE_HOOK_RELATIVE_PATH,
} from "../src/lib/cross-agent-capture-setup-core.ts";

test("mergeClaudeCodeLocalSettings adds a SessionEnd hook to an empty/missing settings file", () => {
  const { content, changed } = mergeClaudeCodeLocalSettings(null);
  assert.equal(changed, true);
  const parsed = JSON.parse(content);
  assert.equal(parsed.hooks.SessionEnd.length, 1);
  assert.match(parsed.hooks.SessionEnd[0].hooks[0].command, /m9r-capture\.mjs.*claude-code/);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].timeout, 5);
});

test("mergeClaudeCodeLocalSettings preserves the user's existing hooks and settings untouched", () => {
  const existing = JSON.stringify({
    permissions: { allow: ["Bash(git *)"] },
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "my-own-script.sh" }] }] },
  });
  const { content, changed } = mergeClaudeCodeLocalSettings(existing);
  assert.equal(changed, true);
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.permissions, { allow: ["Bash(git *)"] });
  assert.equal(parsed.hooks.SessionEnd.length, 2, "the user's own SessionEnd hook must survive alongside ours");
  assert.ok(parsed.hooks.SessionEnd.some((g: any) => g.hooks.some((h: any) => h.command === "my-own-script.sh")));
});

test("mergeClaudeCodeLocalSettings is idempotent -- running it twice does not duplicate the hook", () => {
  const first = mergeClaudeCodeLocalSettings(null);
  const second = mergeClaudeCodeLocalSettings(first.content);
  assert.equal(second.changed, false, "a second connect must not re-add an already-installed hook");
  const parsed = JSON.parse(second.content);
  assert.equal(parsed.hooks.SessionEnd.length, 1);
});

test("mergeCodexHooks adds a SessionEnd hook with Codex's tighter timeout", () => {
  const { content, changed } = mergeCodexHooks(null);
  assert.equal(changed, true);
  const parsed = JSON.parse(content);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.match(parsed.hooks.SessionEnd[0].hooks[0].command, /m9r-capture\.mjs codex/);
});

test("mergeCodexHooks is idempotent and preserves unrelated existing config", () => {
  const existing = JSON.stringify({ someOtherHook: { PreToolUse: [] } });
  const first = mergeCodexHooks(existing);
  const second = mergeCodexHooks(first.content);
  assert.equal(second.changed, false);
  const parsed = JSON.parse(second.content);
  assert.deepEqual(parsed.someOtherHook, { PreToolUse: [] });
});

test("buildOpenCodeMemoryPlugin produces a dependency-free plugin using only the confirmed session.messages API", () => {
  const source = buildOpenCodeMemoryPlugin();
  assert.match(source, /client\.session\.messages\(\{ sessionID \}\)/);
  assert.match(source, /session\.idle/);
  assert.match(source, /session\.status/, "must also handle session.status, session.idle's documented replacement");
  assert.doesNotMatch(source, /require\(["'](?!node:)/, "must not pull in a third-party dependency");
});

test("CAPTURE_HOOK_SCRIPT_SOURCE is a minimal, dependency-free stdin-to-spool script", () => {
  assert.match(CAPTURE_HOOK_SCRIPT_SOURCE, /process\.stdin/);
  assert.match(CAPTURE_HOOK_SCRIPT_SOURCE, /pending\.jsonl/);
  assert.doesNotMatch(CAPTURE_HOOK_SCRIPT_SOURCE, /require\(["'](?!node:)/);
  assert.equal(CAPTURE_HOOK_RELATIVE_PATH, ".oathlock/bin/m9r-capture.mjs");
});
