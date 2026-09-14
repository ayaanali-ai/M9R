import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  assert.ok(
    parsed.hooks.SessionEnd.some((group: { hooks: { command: string }[] }) =>
      group.hooks.some((hook) => hook.command === "my-own-script.sh"),
    ),
  );
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

test("buildOpenCodeMemoryPlugin produces a dependency-free plugin using the generated SDK session.messages API", () => {
  const source = buildOpenCodeMemoryPlugin();
  assert.match(source, /client\.session\.messages\(\{ path: \{ id: sessionID \} \}\)/);
  assert.match(source, /client\.session\.messages\(\{ sessionID \}\)/);
  assert.match(source, /session\.idle/);
  assert.match(source, /session\.status/, "must also handle session.status, session.idle's documented replacement");
  assert.doesNotMatch(source, /require\(["'](?!node:)/, "must not pull in a third-party dependency");
});

test("generated OpenCode plugin retries an empty initial idle event and captures the later completed session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-opencode-plugin-"));
  const pluginPath = join(dir, "m9r-memory.mjs");
  await writeFile(pluginPath, buildOpenCodeMemoryPlugin(), "utf8");
  try {
    const imported = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`) as {
      M9rMemoryPlugin: (input: unknown) => Promise<{ event(input: unknown): Promise<void> }>;
    };
    let messages: unknown[] = [];
    const logs: unknown[] = [];
    const client = {
      session: { messages: async (input: unknown) => {
        assert.deepEqual(input, { path: { id: "ses_live" } });
        return { data: messages };
      } },
      app: { log: async (entry: unknown) => { logs.push(entry); } },
    };
    const plugin = await imported.M9rMemoryPlugin({ client, directory: dir, project: null });

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_live" } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(access(join(dir, ".oathlock", "capture", "pending.jsonl")));

    messages = [{ info: { role: "user" }, parts: [{ type: "text", text: "live prompt" }] }];
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "ses_live", status: { type: "idle" } } } });

    let spool = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { spool = await readFile(join(dir, ".oathlock", "capture", "pending.jsonl"), "utf8"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    assert.match(spool, /"provider":"opencode"/);
    assert.match(spool, /live prompt/);
    assert.deepEqual(logs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CAPTURE_HOOK_SCRIPT_SOURCE is a minimal, dependency-free stdin-to-spool script", () => {
  assert.match(CAPTURE_HOOK_SCRIPT_SOURCE, /process\.stdin/);
  assert.match(CAPTURE_HOOK_SCRIPT_SOURCE, /pending\.jsonl/);
  assert.doesNotMatch(CAPTURE_HOOK_SCRIPT_SOURCE, /require\(["'](?!node:)/);
  assert.equal(CAPTURE_HOOK_RELATIVE_PATH, ".oathlock/bin/m9r-capture.mjs");
});
