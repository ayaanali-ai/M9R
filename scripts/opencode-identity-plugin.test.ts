import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildOpenCodeIdentityPluginSource,
  extractOpenCodeAdditionalContext,
  planOpenCodeIdentityPluginInstall,
  planOpenCodeIdentityPluginRemoval,
  resolveOpenCodeGlobalPaths,
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

function evaluateGeneratedPlugin(
  source: string,
  mockedSpawn: ReturnType<typeof createMockSpawn>,
  setIntervalFn: typeof setInterval = setInterval,
  clearIntervalFn: typeof clearInterval = clearInterval,
) {
  const executable = source
    .replace(/^import \{ spawn \} from "node:child_process";\r?\n/m, "")
    .replace(/^export const M9rIdentity = /m, "const M9rIdentity = ");
  return new Function("spawn", "process", "setInterval", "clearInterval", `${executable}\nreturn M9rIdentity;`)(mockedSpawn, { cwd: () => "C:/process-cwd" }, setIntervalFn, clearIntervalFn) as
    (context: { directory?: string; client?: { session?: { prompt?: (input: unknown) => Promise<unknown>; promptAsync?: (input: unknown) => Promise<unknown>; list?: (input?: unknown) => Promise<unknown>; status?: (input?: unknown) => Promise<unknown> } } }) => Promise<{ "experimental.chat.system.transform": (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> }>;
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

test("OpenCode setup follows the legacy ~/.opencode config when that is the active layout", () => {
  const paths = resolveOpenCodeGlobalPaths({
    home: "C:/Users/Ada",
    exists: (path) => /[\\/]\.opencode[\\/]opencode\.json$/.test(path),
  });
  assert.deepEqual(paths, {
    configPath: "C:\\Users\\Ada\\.opencode\\opencode.json",
    pluginDirectory: "C:\\Users\\Ada\\.opencode\\plugins",
  });
});

test("session and prompt-time additionalContext are eligible for system injection", () => {
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "trusted M9R identity" },
    other: "ignored",
  })), "trusted M9R identity");
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "M9R inbox (1 new)" },
  })), "M9R inbox (1 new)");
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "OpenCodePoll", additionalContext: JSON.stringify({ task_id: "T3", prompt: "task" }) },
  })), JSON.stringify({ task_id: "T3", prompt: "task" }));
  assert.equal(extractOpenCodeAdditionalContext(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "wrong event" },
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
  assert.match(source, /M9R_HOOK_PROMPT_ARGS[\s\S]*"m9r-hook",\s*"UserPromptSubmit",\s*"opencode"/);
  assert.match(source, /runM9rPrompt\(sessionID, cwd\)/);
  assert.match(source, /client\?\.session\?\.promptAsync \?\? client\?\.session\?\.prompt/);
  assert.match(source, /M9R_HOOK_POLL_ARGS/);
  assert.match(source, /M9R_HOOK_DELIVERED_ARGS/);
});

test("OpenCode live polling creates one real session turn and records receipt only after it completes", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const taskEnvelope = JSON.stringify({ task_id: "T42", prompt: "[M9R T42]\nReview the staged patch\nM9R token" });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const outcomes = [
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", taskEnvelope) },
    { code: 0, output: hook("OpenCodeDelivered", JSON.stringify({ accepted: true, task_id: "T42" })) },
    { code: 0, output: hook("OpenCodePoll", "") },
  ];
  const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const setIntervalMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalMock = (() => undefined) as typeof clearInterval;
  const pluginFactory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({
    command: "m9r-engine",
    args: ["m9r-hook", "SessionStart", "opencode"],
  }), createMockSpawn(outcomes, calls), setIntervalMock, clearIntervalMock);
  let finishPrompt!: () => void;
  const promptPending = new Promise<void>((resolve) => { finishPrompt = resolve; });
  const prompts: unknown[] = [];
  const plugin = await pluginFactory({
    directory: "C:/repo",
    client: { session: { prompt: async (input) => { prompts.push(input); await promptPending; return {}; } } },
  });
  await plugin["experimental.chat.system.transform"]({ sessionID: "oc-session" }, { system: [] });

  const waitFor = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 40 && !ready(); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ready(), true, "live OpenCode operation should reach the expected state");
  };
  await waitFor(() => prompts.length === 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 1500);
  assert.deepEqual(prompts[0], {
    path: { id: "oc-session" },
    body: { parts: [{ type: "text", text: "[M9R T42]\nReview the staged patch\nM9R token" }] },
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ["m9r-hook", "SessionStart", "opencode"],
    ["m9r-hook", "UserPromptSubmit", "opencode"],
    ["m9r-hook", "OpenCodePoll", "opencode"],
  ]);

  timers[0]!.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 1, "a session cannot receive a second task while its current M9R prompt is active");
  assert.equal(calls.length, 3, "the busy-session guard prevents another poll while the prompt is in flight");

  finishPrompt();
  await waitFor(() => calls.length === 4);
  assert.deepEqual(calls[3]!.args, ["m9r-hook", "OpenCodeDelivered", "opencode"]);
  assert.deepEqual(JSON.parse(calls[3]!.input), { session_id: "oc-session", cwd: "C:/repo", task_id: "T42" });
  timers[0]!.callback();
  await waitFor(() => calls.length === 5);
  assert.equal(prompts.length, 1, "an acknowledged task is not pushed twice");
});

test("OpenCode startup discovers active sessions so inbox delivery does not wait for a prompt", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const setIntervalMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: JSON.stringify({ hookSpecificOutput: { hookEventName: "OpenCodePoll", additionalContext: "" } }) },
  ], calls), setIntervalMock);
  const prompts: unknown[] = [];
  const plugin = await factory({
    directory: "C:/repo",
    client: {
      session: {
        list: async (input) => ({ data: [{ id: "open-session", directory: "C:/repo" }], input }),
        status: async () => ({ data: { "open-session": { type: "idle" } } }),
        prompt: async (input) => { prompts.push(input); return {}; },
      },
    },
  });
  for (let attempt = 0; attempt < 20 && timers.length === 0; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 1500);
  assert.deepEqual(calls[0]?.args, ["m9r-hook", "OpenCodePoll", "opencode"]);
  assert.deepEqual(JSON.parse(calls[0]!.input), { session_id: "open-session", cwd: "C:/repo" });
  assert.equal(prompts.length, 0);
  void plugin;
});

test("a resolved OpenCode SDK error never acknowledges task delivery", async () => {
  const hook = (event: string, context: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T1", prompt: "cursor task" })) },
  ], calls), (() => ({ unref() {} })) as unknown as typeof setInterval);
  const plugin = await factory({ directory: "C:/repo", client: { session: { prompt: async () => ({ error: { message: "session unavailable" } }) } } });
  await plugin["experimental.chat.system.transform"]({ sessionID: "oc-session" }, { system: [] });
  for (let attempt = 0; attempt < 10; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.args.includes("OpenCodeDelivered")).length, 0);
});

test("OpenCode uses promptAsync so a later model failure cannot replay an accepted M9R task", async () => {
  const hook = (event: string, context: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T2", prompt: "cursor task" })) },
    { code: 0, output: hook("OpenCodeDelivered", JSON.stringify({ accepted: true, task_id: "T2" })) },
    { code: 0, output: hook("OpenCodePoll", "") },
  ], calls), (() => ({ unref() {} })) as unknown as typeof setInterval);
  const asyncPrompts: unknown[] = [];
  let blockingPromptCalls = 0;
  const plugin = await factory({
    directory: "C:/repo",
    client: { session: {
      promptAsync: async (input) => { asyncPrompts.push(input); return { data: undefined }; },
      prompt: async () => { blockingPromptCalls += 1; return { error: { message: "model failed after accepting the turn" } }; },
    } },
  });
  await plugin["experimental.chat.system.transform"]({ sessionID: "oc-session" }, { system: [] });
  for (let attempt = 0; attempt < 20 && calls.filter((call) => call.args.includes("OpenCodeDelivered")).length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(asyncPrompts.length, 1);
  assert.equal(blockingPromptCalls, 0, "M9R must not wait for model completion before acknowledging delivery");
  assert.equal(calls.filter((call) => call.args.includes("OpenCodeDelivered")).length, 1);
});

test("generated plugin shares one successful bootstrap per session, delivers prompt-time inbox, and retries failures", async () => {
  const sessionResponse = (additionalContext: unknown, extra = "") => JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    extra,
  });
  const promptResponse = (additionalContext: unknown) => JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
  });
  const promptEmpty = () => ({ code: 0, output: promptResponse("") });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const spawn = createMockSpawn([
    { code: 0, output: sessionResponse("trusted M9R context", "ignore this field") },
    promptEmpty(),
    promptEmpty(),
    { code: 0, output: promptResponse("M9R inbox (1 new)") },
    { code: 1, output: sessionResponse("failed attempt") },
    promptEmpty(),
    { code: 0, output: sessionResponse("recovered M9R context") },
    promptEmpty(),
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
  // One shared bootstrap plus one prompt-time hook run per turn; empty turns push nothing.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ["m9r-hook", "SessionStart", "opencode"]);
  assert.deepEqual(calls[1]!.args, ["m9r-hook", "UserPromptSubmit", "opencode"]);
  assert.deepEqual(calls[2]!.args, ["m9r-hook", "UserPromptSubmit", "opencode"]);
  assert.equal(JSON.parse(calls[1]!.input).cwd, "C:/project");
  assert.deepEqual(first.system, ["trusted M9R context"]);
  assert.deepEqual(concurrent.system, ["trusted M9R context"]);
  // The bootstrap stays cached, but every turn still asks for inbox deltas: one arrives here.
  const continuation = { system: [] as string[] };
  await transform({ sessionID: "session-success" }, continuation);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3]!.args, ["m9r-hook", "UserPromptSubmit", "opencode"]);
  assert.deepEqual(continuation.system, ["trusted M9R context", "M9R inbox (1 new)"]);

  const failed = { system: [] as string[] };
  await transform({ sessionID: "session-retry" }, failed);
  assert.deepEqual(failed.system, []);
  const retried = { system: [] as string[] };
  await transform({ sessionID: "session-retry" }, retried);
  assert.equal(calls.length, 8);
  assert.deepEqual(retried.system, ["recovered M9R context"]);
});

test("a failing prompt-time hook is silent and never blocks the turn", async () => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const spawn = createMockSpawn([
    { code: 0, output: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" } }) },
    { code: 1, output: "hook exploded" },
  ], calls);
  const pluginFactory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({
    command: "C:/m9r/m9r-engine.exe",
    args: ["m9r-hook", "SessionStart", "opencode"],
  }), spawn);
  const transform = (await pluginFactory({ directory: "C:/project" }))["experimental.chat.system.transform"];
  const output = { system: [] as string[] };
  await transform({ sessionID: "s prompted", }, output);
  assert.deepEqual(output.system, ["ctx"]);
});

test("generated plugin bounds successful per-session bootstrap cache", async () => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const bootstrapOk = () => ({
    code: 0,
    output: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context" } }),
  });
  const promptEmpty = () => ({
    code: 0,
    output: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "" } }),
  });
  const outcomes = Array.from({ length: 620 }, (_, index) => index % 2 === 0 ? bootstrapOk() : promptEmpty());
  const pluginFactory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({
    command: "m9r-engine",
    args: ["m9r-hook", "SessionStart", "opencode"],
  }), createMockSpawn(outcomes, calls));
  const transform = (await pluginFactory({ directory: "C:/project" }))["experimental.chat.system.transform"];
  for (let index = 0; index <= 256; index += 1) {
    await transform({ sessionID: `session-${index}` }, { system: [] });
  }
  // 257 fresh sessions, each with one bootstrap and one prompt-time hook run.
  assert.equal(calls.length, 514);
  await transform({ sessionID: "session-256" }, { system: [] });
  assert.equal(calls.length, 515, "recent settled sessions remain cached (prompt hook still runs)");
  await transform({ sessionID: "session-0" }, { system: [] });
  assert.equal(calls.length, 517, "the oldest settled session is evicted after the cache reaches its bound");
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
