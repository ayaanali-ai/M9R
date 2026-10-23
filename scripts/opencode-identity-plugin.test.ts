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
  setTimeoutFn: typeof setTimeout = setTimeout,
  clearTimeoutFn: typeof clearTimeout = clearTimeout,
) {
  const executable = source
    .replace(/^import \{ spawn \} from "node:child_process";\r?\n/m, "")
    .replace(/^export const M9rIdentity = /m, "const M9rIdentity = ")
    .replace(/^export default M9rOpenCodePlugin;\r?\n/m, "");
  return new Function("spawn", "process", "setInterval", "clearInterval", "setTimeout", "clearTimeout", `${executable}\nreturn M9rIdentity;`)(mockedSpawn, { cwd: () => "C:/process-cwd" }, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn) as
    (context: { directory?: string; client?: { config?: { providers?: () => Promise<unknown> }; session?: { prompt?: (input: unknown) => Promise<unknown>; promptAsync?: (input: unknown) => Promise<unknown>; list?: (input?: unknown) => Promise<unknown>; status?: (input?: unknown) => Promise<unknown>; messages?: (input?: unknown) => Promise<unknown> } } }) => Promise<{ "experimental.chat.system.transform": (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>; event?: (input: { event?: unknown }) => Promise<void> }>;
}

function evaluateGeneratedPluginV2(
  source: string,
  mockedSpawn: ReturnType<typeof createMockSpawn>,
  setIntervalFn: typeof setInterval = setInterval,
  clearIntervalFn: typeof clearInterval = clearInterval,
) {
  const executable = source
    .replace(/^import \{ spawn \} from "node:child_process";\r?\n/m, "")
    .replace(/^export const M9rIdentity = /m, "const M9rIdentity = ")
    .replace(/^export default M9rOpenCodePlugin;\r?\n/m, "");
  return new Function("spawn", "process", "setInterval", "clearInterval", `${executable}\nreturn M9rOpenCodePlugin;`)(mockedSpawn, { cwd: () => "C:/process-cwd" }, setIntervalFn, clearIntervalFn) as {
    setup: (context: {
      location?: { directory?: string };
      data?: { session?: { status?: (sessionID: string) => unknown | Promise<unknown> } };
      client?: { session?: { list?: (input?: unknown) => Promise<unknown>; promptAsync?: (input: unknown) => Promise<unknown> } };
      session?: { hook?: (name: string, callback: (event: { sessionID?: string; system?: Array<{ type: string; text: string }> }) => Promise<void>) => Promise<unknown> };
      event?: { subscribe?: (input?: { signal?: AbortSignal }) => AsyncIterable<unknown> };
    }) => Promise<(() => void) | undefined>;
  };
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
    configPaths: ["C:\\Users\\Ada\\.opencode\\opencode.json"],
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
  assert.match(source, /session\.promptAsync\.call/);
  assert.match(source, /sessionID,[\s\S]*directory:[\s\S]*parts:/);
  assert.match(source, /M9R_HOOK_POLL_ARGS/);
  assert.match(source, /M9R_HOOK_DELIVERED_ARGS/);
  assert.match(source, /OpenCodeExecutionFailed/);
  assert.match(source, /event:\s*async/);
  assert.doesNotMatch(source, /\b__name\b/, "standalone plugin must not depend on a bundler helper");
});

test("generated plugin exports the OpenCode V2 default setup definition while retaining the V1 server bridge", () => {
  const source = buildOpenCodeIdentityPluginSource({
    command: "C:/Users/Ada/.m9r/bin/m9r-engine.exe",
    args: ["m9r-hook", "SessionStart", "opencode"],
  });
  assert.match(source, /const M9rOpenCodePlugin = \{[\s\S]*?id:\s*["']m9r-identity["']/);
  assert.match(source, /async function setupM9rOpenCodeV2\(/);
  assert.match(source, /setup:\s*setupM9rOpenCodeV2/);
  assert.match(source, /ctx\??\.session\??\.hook\??\("context"/);
  assert.match(source, /server:\s*M9rIdentity/);
  assert.match(source, /export default M9rOpenCodePlugin;/);
});

test("OpenCode V2 setup registers a context hook and preserves typed M9R system context", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const source = buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] });
  const plugin = evaluateGeneratedPluginV2(source, createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "M9R inbox delta") },
  ], calls));
  const registrations: Array<{ name: string; callback: (event: { sessionID?: string; system?: Array<{ type: string; text: string }> }) => Promise<void> }> = [];
  const cleanup = await plugin.setup({
    location: { directory: "C:/repo" },
    session: {
      hook: async (name, callback) => {
        registrations.push({ name, callback });
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          // The event stream is intentionally empty for this setup contract test.
        },
      }),
    },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]!.name, "context");
  const request = { sessionID: "v2-session", system: [] as Array<{ type: string; text: string }> };
  await registrations[0]!.callback(request);
  assert.deepEqual(request.system, [
    { type: "text", text: "connected" },
    { type: "text", text: "M9R inbox delta" },
  ]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["m9r-hook", "SessionStart", "opencode"],
    ["m9r-hook", "UserPromptSubmit", "opencode"],
  ]);
  cleanup?.();
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
    client: { session: { promptAsync: async (input) => { prompts.push(input); await promptPending; return {}; } } },
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
    sessionID: "oc-session",
    directory: "C:/repo",
    parts: [{ type: "text", text: "[M9R T42]\nReview the staged patch\nM9R token" }],
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
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("OpenCodePoll", "") },
  ], calls), setIntervalMock);
  const prompts: unknown[] = [];
  const plugin = await factory({
    directory: "C:/repo",
    client: {
      session: {
        list: async (input) => ({ data: [{ id: "open-session", directory: "C:/repo" }], input }),
        status: async () => ({ data: { "open-session": { type: "idle" } } }),
        promptAsync: async (input) => { prompts.push(input); return {}; },
      },
    },
  });
  for (let attempt = 0; attempt < 20 && timers.length === 0; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 1500);
  assert.deepEqual(calls[0]?.args, ["m9r-hook", "SessionStart", "opencode"]);
  assert.deepEqual(JSON.parse(calls[0]!.input), { session_id: "open-session", cwd: "C:/repo" });
  assert.deepEqual(calls[1]?.args, ["m9r-hook", "OpenCodePoll", "opencode"]);
  assert.deepEqual(JSON.parse(calls[1]!.input), { session_id: "open-session", cwd: "C:/repo" });
  assert.equal(prompts.length, 0);
  void plugin;
});

test("OpenCode V2 startup uses the current flat session list and live status surface", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const setIntervalMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const factory = evaluateGeneratedPluginV2(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("OpenCodePoll", "") },
  ], calls), setIntervalMock);
  const listInputs: unknown[] = [];
  const plugin = await factory.setup({
    location: { directory: "C:/repo" },
    data: {
      session: {
        status: (sessionID: string) => sessionID === "v2-session" ? { type: "idle" } : undefined,
      },
    },
    client: {
      session: {
        list: async (input) => {
          listInputs.push(input);
          return [{ id: "v2-session", location: { directory: "C:/repo" }, time: {} }];
        },
        promptAsync: async () => ({}),
      },
    },
  });
  for (let attempt = 0; attempt < 30 && timers.length === 0; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1, "a live V2 session should receive an automatic poller at setup");
  assert.deepEqual(listInputs, [{ directory: "C:/repo" }]);
  assert.equal(calls.filter((call) => call.args.includes("OpenCodePoll")).length, 1);
  plugin?.();
});

test("OpenCode retries the legacy promptAsync shape only after request validation rejects the modern shape", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const prompts: unknown[] = [];
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T43", prompt: "legacy-compatible task" })) },
    { code: 0, output: hook("OpenCodeDelivered", JSON.stringify({ accepted: true, task_id: "T43" })) },
  ], calls), (() => ({ unref() {} })) as unknown as typeof setInterval);
  const plugin = await factory({
    directory: "C:/repo",
    client: {
      session: {
        promptAsync: async (input) => {
          prompts.push(input);
          if (input && typeof input === "object" && "sessionID" in input) throw new Error("Invalid request: unknown parameter sessionID");
          return {};
        },
      },
    },
  });
  await plugin["experimental.chat.system.transform"]({ sessionID: "oc-legacy" }, { system: [] });
  for (let attempt = 0; attempt < 30 && calls.filter((call) => call.args.includes("OpenCodeDelivered")).length === 0; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0], {
    sessionID: "oc-legacy",
    directory: "C:/repo",
    parts: [{ type: "text", text: "legacy-compatible task" }],
  });
  assert.deepEqual(prompts[1], {
    path: { id: "oc-legacy" },
    body: { parts: [{ type: "text", text: "legacy-compatible task" }] },
  });
  assert.equal(calls.filter((call) => call.args.includes("OpenCodeDelivered")).length, 1);
});

test("OpenCode startup retries discovery when the provider session API is not ready yet", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const intervalTimers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const timeoutTimers: Array<{ callback: () => void; ms: number; unref: () => void; cleared: boolean }> = [];
  const setIntervalMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined };
    intervalTimers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalMock = (() => undefined) as typeof clearInterval;
  const setTimeoutMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined, cleared: false };
    timeoutTimers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutMock = ((timer: unknown) => {
    if (timer && typeof timer === "object" && "cleared" in timer) (timer as { cleared: boolean }).cleared = true;
  }) as typeof clearTimeout;
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected after provider startup") },
  ], calls), setIntervalMock, clearIntervalMock, setTimeoutMock, clearTimeoutMock);
  let listAttempts = 0;
  const plugin = await factory({
    directory: "C:/repo",
    client: {
      session: {
        list: async () => {
          listAttempts += 1;
          return listAttempts === 1 ? { error: "session API warming up" } : { data: [{ id: "recovered-session", directory: "C:/repo" }] };
        },
        status: async () => ({ data: { "recovered-session": { type: "idle" } } }),
        promptAsync: async () => ({}),
      },
    },
  });
  for (let attempt = 0; attempt < 20 && (listAttempts < 1 || !timeoutTimers.some((timer) => !timer.cleared && timer.ms === 5000)); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(listAttempts, 1);
  const retry = timeoutTimers.find((timer) => !timer.cleared && timer.ms === 5000);
  assert.ok(retry, "a failed startup discovery must schedule a bounded retry");
  retry!.callback();
  for (let attempt = 0; attempt < 20 && calls.length < 1; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(listAttempts, 2);
  assert.deepEqual(calls[0]?.args, ["m9r-hook", "SessionStart", "opencode"]);
  assert.equal(intervalTimers.length, 1, "the recovered session must receive its poller without a user prompt");
  void plugin;
});

test("OpenCode session lifecycle events rebind identity and start delivery polling", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const setIntervalMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("OpenCodePoll", "") },
    { code: 0, output: hook("SessionStart", "reconnected after compaction") },
    { code: 0, output: hook("OpenCodePoll", "") },
  ], calls), setIntervalMock);
  const plugin = await factory({
    directory: "C:/repo",
    client: { session: { promptAsync: async () => ({}) } },
  });

  await plugin.event!({ event: { type: "session.created", properties: { sessionID: "created-session" } } });
  for (let attempt = 0; attempt < 20 && calls.length < 2; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.args), [
    ["m9r-hook", "SessionStart", "opencode"],
    ["m9r-hook", "OpenCodePoll", "opencode"],
  ]);

  await plugin.event!({ event: { type: "session.compacted", properties: { sessionID: "created-session" } } });
  for (let attempt = 0; attempt < 20 && calls.length < 4; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1, "reconciliation must reuse the session poller");
  assert.deepEqual(calls.slice(2).map((call) => call.args), [
    ["m9r-hook", "SessionStart", "opencode"],
    ["m9r-hook", "OpenCodePoll", "opencode"],
  ]);
});

test("deleting an OpenCode session retires its poller and closes active delivery", async () => {
  const hook = (event: string, additionalContext: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const cleared: unknown[] = [];
  const setIntervalMock = ((callback: () => void, ms = 0) => {
    const timer = { callback, ms, unref: () => undefined };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalMock = ((timer: unknown) => { cleared.push(timer); }) as typeof clearInterval;
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T77", prompt: "[M9R T77]\nwork" })) },
    { code: 0, output: hook("OpenCodeDelivered", JSON.stringify({ accepted: true, task_id: "T77" })) },
    { code: 0, output: hook("OpenCodeExecutionFailed", JSON.stringify({ accepted: true, task_id: "T77" })) },
  ], calls), setIntervalMock, clearIntervalMock);
  const plugin = await factory({
    directory: "C:/repo",
    client: { session: { promptAsync: async () => ({}) } },
  });
  await plugin["experimental.chat.system.transform"]({ sessionID: "deleted-session" }, { system: [] });
  for (let attempt = 0; attempt < 30 && calls.filter((call) => call.args.includes("OpenCodeDelivered")).length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(calls.filter((call) => call.args.includes("OpenCodeDelivered")).length, 1);

  await plugin.event!({ event: { type: "session.deleted", properties: { sessionID: "deleted-session" } } });
  for (let attempt = 0; attempt < 20 && calls.filter((call) => call.args.includes("OpenCodeExecutionFailed")).length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(cleared.length, 1);
  const failure = calls.find((call) => call.args.includes("OpenCodeExecutionFailed"));
  assert.ok(failure);
  assert.deepEqual(JSON.parse(failure!.input), {
    session_id: "deleted-session",
    cwd: "C:/repo",
    task_id: "T77",
    execution_error: "session_deleted",
    execution_detail: "OpenCode session was deleted before the M9R task completed.",
  });
});

test("a resolved OpenCode SDK error never acknowledges task delivery", async () => {
  const hook = (event: string, context: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T1", prompt: "cursor task" })) },
  ], calls), (() => ({ unref() {} })) as unknown as typeof setInterval);
  const plugin = await factory({ directory: "C:/repo", client: { session: { promptAsync: async () => ({ error: { message: "session unavailable" } }) } } });
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

test("a late OpenCode provider failure terminally reports the already-accepted M9R task", async () => {
  const hook = (event: string, context: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T3", prompt: "[M9R T3]\nopen the safe app" })) },
    { code: 0, output: hook("OpenCodeDelivered", JSON.stringify({ accepted: true, task_id: "T3" })) },
    { code: 0, output: hook("OpenCodeExecutionFailed", JSON.stringify({ accepted: true, task_id: "T3" })) },
  ], calls), (() => ({ unref() {} })) as unknown as typeof setInterval);
  const plugin = await factory({
    directory: "C:/repo",
    client: { session: { promptAsync: async () => ({ data: undefined }) } },
  });
  await plugin["experimental.chat.system.transform"]({ sessionID: "oc-session" }, { system: [] });
  for (let attempt = 0; attempt < 20 && calls.filter((call) => call.args.includes("OpenCodeDelivered")).length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(calls.filter((call) => call.args.includes("OpenCodeDelivered")).length, 1);
  assert.equal(typeof plugin.event, "function");
  await plugin.event!({ event: {
    type: "session.error",
    properties: { sessionID: "oc-session", error: { name: "ProviderModelNotFoundError", message: "model unavailable" } },
  } });
  for (let attempt = 0; attempt < 20 && calls.filter((call) => call.args.includes("OpenCodeExecutionFailed")).length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const failure = calls.find((call) => call.args.includes("OpenCodeExecutionFailed"));
  assert.ok(failure, "a provider failure after prompt acceptance must close the task");
  assert.deepEqual(JSON.parse(failure!.input), {
    session_id: "oc-session",
    cwd: "C:/repo",
    task_id: "T3",
    execution_error: "provider_execution_failed",
    execution_detail: "model unavailable",
  });
});

test("an OpenCode task overrides a stale in-memory model only with a live catalog model", async () => {
  const hook = (event: string, context: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const prompts: unknown[] = [];
  const factory = evaluateGeneratedPlugin(buildOpenCodeIdentityPluginSource({ command: "m9r-engine", args: ["m9r-hook", "SessionStart", "opencode"] }), createMockSpawn([
    { code: 0, output: hook("SessionStart", "connected") },
    { code: 0, output: hook("UserPromptSubmit", "") },
    { code: 0, output: hook("OpenCodePoll", JSON.stringify({ task_id: "T4", prompt: "[M9R T4]\nuse the current model" })) },
    { code: 0, output: hook("OpenCodeDelivered", JSON.stringify({ accepted: true, task_id: "T4" })) },
  ], calls), (() => ({ unref() {} })) as unknown as typeof setInterval);
  const plugin = await factory({
    directory: "C:/repo",
    client: {
      config: { providers: async () => ({ data: { providers: [{ id: "opencode", default: "beam-free", models: {
        "muse-spark-1.3-contributor-free": { status: "deprecated" },
        "beam-free": { status: "active" },
      } }] } }) },
      session: { promptAsync: async (input) => { prompts.push(input); return {}; } },
    },
  });
  await plugin["experimental.chat.system.transform"]({ sessionID: "oc-session-model" }, { system: [] });
  for (let attempt = 0; attempt < 20 && prompts.length === 0; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts[0], {
    sessionID: "oc-session-model",
    directory: "C:/repo",
    parts: [{ type: "text", text: "[M9R T4]\nuse the current model" }],
    model: { providerID: "opencode", modelID: "beam-free" },
  });
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
