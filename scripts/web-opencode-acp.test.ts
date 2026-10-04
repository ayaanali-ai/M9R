import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeAcpRuntime } from "@/lib/native/web-opencode-acp";

test("OpenCode ACP launches once, resumes the same provider session, streams turns, and shuts down once", async () => {
  const calls: string[] = [];
  const prompts: string[] = [];
  let capturedOptions: Record<string, unknown> | undefined;
  let assignment: Record<string, unknown> | undefined;
  let server: unknown;
  let session: unknown;
  const runtime = createOpenCodeAcpRuntime({
    exe: "C:/Program Files/OpenCode/opencode.exe",
    cwd: "C:/Work/Project",
    env: { XDG_CONFIG_HOME: "C:/M9R/isolated-config" },
    handle: "opencode",
    missionId: "project-room",
    model: "opencode/big-pickle",
    resumeId: "ses_previous_123",
    adapterFactory: (options) => {
      capturedOptions = options;
      const adapter = {
        id: "opencode-acp",
        launchServer: async (input: { assignment: Record<string, unknown>; environment: { workingDirectory: string; kind: string } }) => {
          calls.push("launch"); assignment = input.assignment; assert.deepEqual(input.environment, { workingDirectory: "C:/Work/Project", kind: "shared" });
          return server = { serverId: "server-1", adapterId: "opencode-acp" };
        },
        initialize: async (handle: unknown) => { calls.push("initialize"); assert.equal(handle, server); return {}; },
        createSession: async () => { calls.push("create"); return session = { sessionId: "session-new", providerSessionRef: "ses_new_123" }; },
        resumeSession: async (input: { server: unknown; providerSessionRef: string; assignment: Record<string, unknown> }) => {
          calls.push("resume"); assert.equal(input.server, server); assert.equal(input.providerSessionRef, "ses_previous_123"); assert.equal(input.assignment, assignment);
          return session = { sessionId: "session-resumed", providerSessionRef: input.providerSessionRef };
        },
        async *prompt(input: { session: unknown; text: string }) {
          calls.push("prompt"); assert.equal(input.session, session); prompts.push(input.text);
          yield { type: "provider.reply_text", sessionId: "session-resumed", occurredAt: "now", payload: { text: "Persistent reply" } };
        },
        cancelTurn: async (input: { session: unknown }) => { calls.push("cancel"); assert.equal(input.session, session); },
        shutdown: async (handle: unknown) => { calls.push("shutdown"); assert.equal(handle, server); },
      };
      return adapter as never;
    },
  });

  assert.deepEqual(await Promise.all([runtime.ready(), runtime.ready()]), [
    { sessionId: "ses_previous_123" }, { sessionId: "ses_previous_123" },
  ]);
  assert.deepEqual(calls, ["launch", "initialize", "resume"]);
  assert.deepEqual(assignment, {
    missionId: "project-room",
    dispatchKey: "web-opencode",
    goal: "Work through the owner's shared M9R browser session using only its governed web tools.",
    executionConstraints: { profile: "web-only" },
    model: "opencode/big-pickle",
    effort: undefined,
  });
  assert.equal((capturedOptions as { command: string }).command, "C:/Program Files/OpenCode/opencode.exe");
  assert.equal((capturedOptions as { shell: boolean }).shell, false, "resolved executable paths are launched without shell parsing");
  assert.deepEqual((capturedOptions as { serverEnv: () => unknown }).serverEnv(), {}, "web MCP config remains the isolated config file's responsibility");

  const received: string[] = [];
  for await (const event of runtime.prompt("first persistent turn")) received.push(String(event.payload.text));
  assert.deepEqual(received, ["Persistent reply"]);
  assert.deepEqual(prompts, ["first persistent turn"]);
  await runtime.cancelTurn();
  runtime.close();
  runtime.close();
  assert.deepEqual(calls, ["launch", "initialize", "resume", "prompt", "cancel", "shutdown"]);
});

test("OpenCode ACP creates a fresh session without a valid persisted provider id", async () => {
  const calls: string[] = [];
  const runtime = createOpenCodeAcpRuntime({
    exe: "opencode.exe", cwd: "C:/Work/Project", env: {}, handle: "opencode", missionId: "room", model: "model",
    resumeId: "not-a-provider-session",
    adapterFactory: () => ({
      id: "opencode-acp",
      launchServer: async () => { calls.push("launch"); return { serverId: "server-1", adapterId: "opencode-acp" }; },
      initialize: async () => { calls.push("initialize"); return {}; },
      createSession: async () => { calls.push("create"); return { sessionId: "session-new", providerSessionRef: "ses_fresh_123" }; },
      resumeSession: async () => { calls.push("resume"); throw new Error("must not resume an invalid id"); },
      prompt: async function* () { return; },
      cancelTurn: async () => undefined,
      shutdown: async () => { calls.push("shutdown"); },
    } as never),
  });
  assert.deepEqual(await runtime.ready(), { sessionId: "ses_fresh_123" });
  assert.deepEqual(calls, ["launch", "initialize", "create"]);
  runtime.close();
});

test("failed OpenCode ACP initialization shuts down the failed provider process", async () => {
  const calls: string[] = [];
  const runtime = createOpenCodeAcpRuntime({
    exe: "opencode.exe", cwd: "C:/Work/Project", env: {}, handle: "opencode", missionId: "room", model: "model",
    adapterFactory: () => ({
      id: "opencode-acp",
      launchServer: async () => { calls.push("launch"); return { serverId: "server-1", adapterId: "opencode-acp" }; },
      initialize: async () => { calls.push("initialize"); throw new Error("ACP init failed"); },
      createSession: async () => { calls.push("create"); return { sessionId: "session-new", providerSessionRef: "ses_123" }; },
      resumeSession: async () => { calls.push("resume"); return { sessionId: "session-old", providerSessionRef: "ses_123" }; },
      prompt: async function* () { return; },
      cancelTurn: async () => undefined,
      shutdown: async () => { calls.push("shutdown"); },
    } as never),
  });
  await assert.rejects(runtime.ready(), /ACP init failed/);
  assert.deepEqual(calls, ["launch", "initialize", "shutdown"]);
  runtime.close();
  assert.deepEqual(calls, ["launch", "initialize", "shutdown"], "failed startup must not leak or shut down twice");
});

test("OpenCode ACP falls back to a fresh session when the saved one cannot be resumed, and reports liveness", async () => {
  let health: "alive" | "dead" = "alive";
  const runtime = createOpenCodeAcpRuntime({
    exe: "opencode.exe", cwd: "C:/Work", env: {}, handle: "opencode", missionId: "room", model: "opencode/big-pickle", resumeId: "ses_gone_123",
    adapterFactory: () => ({
      launchServer: async () => ({ serverId: "s", adapterId: "opencode-acp" }),
      initialize: async () => ({}),
      resumeSession: async () => { throw new Error("session not found"); },
      createSession: async () => ({ sessionId: "x", providerSessionRef: "ses_fresh_456" }),
      prompt: async function* () { /* unused */ },
      cancelTurn: async () => undefined,
      shutdown: async () => undefined,
      getServerHealth: () => ({ state: health, detail: "" }),
    }) as never,
  });
  assert.equal(runtime.alive?.(), true, "alive before launch");
  assert.deepEqual(await runtime.ready(), { sessionId: "ses_fresh_456", restored: false });
  assert.equal(runtime.alive?.(), true);
  health = "dead";
  assert.equal(runtime.alive?.(), false, "a provider process that exited is reported dead");
  health = "alive";
  runtime.close();
  assert.equal(runtime.alive?.(), false, "a closed runtime is dead");
});
