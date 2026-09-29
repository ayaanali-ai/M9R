import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildOpenCodeIdentityPluginSource,
  extractOpenCodeAdditionalContext,
  planOpenCodeIdentityPluginInstall,
  planOpenCodeIdentityPluginRemoval,
  resolveOpenCodeHookInvocation,
} from "../src/lib/native/web-setup-core.ts";

type HookOutcome = { code: number; output: string };

function createMockSpawn(outcomes: HookOutcome[], calls: Array<{ command: string; args: string[]; input: string }>) {
  return (command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding(encoding: string): void };
      stdin: EventEmitter & { end(input: string): void };
      kill(): void;
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: (_encoding: string) => undefined });
    child.stdin = Object.assign(new EventEmitter(), {
      end: (input: string) => {
        calls.push({ command, args, input });
        const outcome = outcomes.shift() ?? { code: 0, output: "" };
        queueMicrotask(() => {
          if (outcome.output) child.stdout.emit("data", outcome.output);
          child.emit("close", outcome.code);
        });
      },
    });
    child.kill = () => undefined;
    return child;
  };
}

function evaluateGeneratedPlugin(source: string, mockedSpawn: ReturnType<typeof createMockSpawn>) {
  const executable = source
    .replace(/^import \{ spawn \} from "node:child_process";\r?\n/m, "")
    .replace(/^export const M9rIdentity = /m, "const M9rIdentity = ");
  return new Function("spawn", "process", `${executable}\nreturn M9rIdentity;`)(mockedSpawn, { cwd: () => "C:/process-cwd" }) as
    (context: { directory?: string }) => Promise<{ "experimental.chat.system.transform": (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> }>;
}

test("OpenCode identity invocation runs the installed engine SessionStart hook", () => {
  assert.deepEqual(resolveOpenCodeHookInvocation({
    nodeCommand: "node.exe",
    engineExecutable: "C:/Users/Ada/.m9r/bin/m9r-engine.exe",
  }), {
    command: "C:/Users/Ada/.m9r/bin/m9r-engine.exe",
    args: ["m9r-hook", "SessionStart", "opencode"],
  });
});

test("OpenCode identity invocation supports the packaged hook script when no engine is available", () => {
  assert.deepEqual(resolveOpenCodeHookInvocation({
    nodeCommand: "node.exe",
    compiledHookPath: "C:/m9r/cli/dist/m9r-hook.js",
  }), {
    command: "node.exe",
    args: ["C:/m9r/cli/dist/m9r-hook.js", "SessionStart", "opencode"],
  });
});

test("only a SessionStart additionalContext is eligible for system injection", () => {
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "trusted M9R identity" },
    other: "ignored",
  })), "trusted M9R identity");
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "wrong event" },
  })), null);
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: 42 },
  })), null);
  assert.equal(extractOpenCodeAdditionalContext("not-json"), null);
});

test("generated plugin uses sessionID and appends only parsed additionalContext to system", () => {
  const source = buildOpenCodeIdentityPluginSource({
    command: "C:/Users/Ada/.m9r/bin/m9r-engine.exe",
    args: ["m9r-hook", "SessionStart", "opencode"],
  });
  assert.match(source, /experimental\.chat\.system\.transform/);
  assert.match(source, /input\??\.sessionID/);
  assert.match(source, /session_id:\s*sessionID/);
  assert.match(source, /directory/);
  assert.match(source, /output\.system\.push\(context\)/);
  assert.doesNotMatch(source, /output\.system\.push\(raw\)/);
});

test("generated plugin shares one successful bootstrap per session, injects only trusted context, and retries failures", async () => {
  const response = (additionalContext: unknown, extra = "") => JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    extra,
  });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const spawn = createMockSpawn([
    { code: 0, output: response("trusted M9R context", "ignore this field") },
    { code: 1, output: response("failed attempt") },
    { code: 0, output: response("recovered M9R context") },
  ], calls);
  const pluginFactory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({
    command: "C:/m9r/m9r-engine.exe",
    args: ["m9r-hook", "SessionStart", "opencode"],
  }), spawn);
  const plugin = await pluginFactory({ directory: "C:/project" });
  const transform = plugin["experimental.chat.system.transform"];
  const first = { system: [] as string[] };
  const concurrent = { system: [] as string[] };
  await Promise.all([
    transform({ sessionID: "session-success" }, first),
    transform({ sessionID: "session-success" }, concurrent),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0]!.input).cwd, "C:/project");
  assert.deepEqual(first.system, ["trusted M9R context"]);
  assert.deepEqual(concurrent.system, ["trusted M9R context"]);
  const continuation = { system: [] as string[] };
  await transform({ sessionID: "session-success" }, continuation);
  assert.equal(calls.length, 1);
  assert.deepEqual(continuation.system, ["trusted M9R context"]);

  const failed = { system: [] as string[] };
  await transform({ sessionID: "session-retry" }, failed);
  assert.deepEqual(failed.system, []);
  const retried = { system: [] as string[] };
  await transform({ sessionID: "session-retry" }, retried);
  assert.equal(calls.length, 3);
  assert.deepEqual(retried.system, ["recovered M9R context"]);
});

test("generated plugin bounds successful per-session bootstrap cache", async () => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const outcomes = Array.from({ length: 258 }, () => ({
    code: 0,
    output: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context" } }),
  }));
  const pluginFactory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({
    command: "m9r-engine",
    args: ["m9r-hook", "SessionStart", "opencode"],
  }), createMockSpawn(outcomes, calls));
  const transform = (await pluginFactory({ directory: "C:/project" }))["experimental.chat.system.transform"];
  for (let index = 0; index <= 256; index += 1) {
    await transform({ sessionID: `session-${index}` }, { system: [] });
  }
  await transform({ sessionID: "session-256" }, { system: [] });
  assert.equal(calls.length, 257, "recent settled sessions remain cached");
  await transform({ sessionID: "session-0" }, { system: [] });
  assert.equal(calls.length, 258, "the oldest settled session is evicted after the cache reaches its bound");
});

test("plugin install and upgrade require path and content ownership; user changes are preserved", () => {
  const targetPath = "C:/Users/Ada/.config/opencode/plugins/m9r-identity.js";
  assert.equal(planOpenCodeIdentityPluginInstall({ targetPath, currentHash: null, desiredHash: "new" }), "install");
  assert.equal(planOpenCodeIdentityPluginInstall({
    targetPath, ownedPath: targetPath, ownedHash: "old", currentHash: "old", desiredHash: "new",
  }), "upgrade");
  assert.equal(planOpenCodeIdentityPluginInstall({
    targetPath, ownedPath: targetPath, ownedHash: "new", currentHash: "new", desiredHash: "new",
  }), "unchanged");
  assert.equal(planOpenCodeIdentityPluginInstall({ targetPath, currentHash: "user", desiredHash: "new" }), "preserve");
  assert.equal(planOpenCodeIdentityPluginInstall({
    targetPath, ownedPath: "C:/old/opencode/plugins/m9r-identity.js", ownedHash: "old", currentHash: "old", desiredHash: "new",
  }), "path-changed");
});

test("plugin uninstall removes only the file still matching the owned path and hash", () => {
  const targetPath = "C:/Users/Ada/.config/opencode/plugins/m9r-identity.js";
  assert.equal(planOpenCodeIdentityPluginRemoval({ targetPath, ownedPath: targetPath, ownedHash: "ours", currentHash: "ours" }), "remove");
  assert.equal(planOpenCodeIdentityPluginRemoval({ targetPath, ownedPath: targetPath, ownedHash: "ours", currentHash: "user" }), "preserve");
  assert.equal(planOpenCodeIdentityPluginRemoval({ targetPath, currentHash: "user" }), "not-owned");
});
