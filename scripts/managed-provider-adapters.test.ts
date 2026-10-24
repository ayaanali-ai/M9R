import assert from "node:assert/strict";
import test from "node:test";
import { normalizeManagedProviderProfile, type ManagedProviderTask } from "@/lib/native/managed-provider-contract";
import {
  createClaudeManagedProviderConnection,
  createCodexManagedProviderConnection,
  createOpenCodeManagedProviderConnection,
} from "@/lib/native/managed-provider-adapters";

function task(profile: ReturnType<typeof normalizeManagedProviderProfile>, generation: number, id: string): ManagedProviderTask {
  return {
    taskId: id,
    connectionId: profile.connectionId,
    handle: profile.handle,
    provider: profile.provider,
    cwd: profile.cwd,
    generation,
    prompt: "read-only adapter smoke test",
  };
}

function fakeClaudeProcess() {
  const output: ((chunk: string) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];
  const writes: string[] = [];
  const process = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        if (chunk.includes('"type":"user"')) {
          output.forEach((listener) => listener(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "claude reply" }] } }) + "\n"));
          output.forEach((listener) => listener(JSON.stringify({ type: "result", result: "claude result", num_turns: 1, total_cost_usd: 0, is_error: false, session_id: "claude-session-1" }) + "\n"));
        }
      },
      end() { exits.forEach((listener) => listener(0)); },
    },
    stdout: { on(_event: "data", listener: (chunk: Buffer | string) => void) { output.push((chunk) => listener(chunk)); } },
    on(event: "exit" | "error", listener: (arg: never) => void) {
      if (event === "exit") exits.push(listener as unknown as (code: number | null) => void);
    },
    kill() { exits.forEach((listener) => listener(0)); },
    emitInit() { output.forEach((listener) => listener(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" }) + "\n")); },
    writes,
  };
  return process;
}

test("Claude adapter uses stream-json and exposes only provider-neutral events", async () => {
  const profile = normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/Work/Project" });
  const process = fakeClaudeProcess();
  const connection = createClaudeManagedProviderConnection({
    profile,
    mcpConfigPath: "C:/Work/mcp.json",
    spawn: () => {
      queueMicrotask(() => process.emitInit());
      return process as never;
    },
  });

  const ready = await connection.start();
  assert.equal(ready.generation, 1);
  assert.deepEqual(ready.continuation, { providerSessionRef: "claude-session-1" });
  const events: unknown[] = [];
  for await (const event of connection.send(task(profile, ready.generation, "T-claude-adapter"))) events.push(event);

  assert.equal(events.some((event) => (event as { kind?: string }).kind === "text"), true);
  assert.deepEqual(events.at(-1), { kind: "status", status: "ready", doing: "Ready" });
  assert.equal(process.writes.some((value) => value.includes("claude reply") === false), true);
  assert.equal("providerSessionRef" in connection.status(), false);
});

test("Codex adapter owns one worker per turn and carries the resume thread", async () => {
  const profile = normalizeManagedProviderProfile({ handle: "codex", provider: "codex", cwd: "C:/Work/Project" });
  let built: { prompt: string; threadId?: string } | undefined;
  const connection = createCodexManagedProviderConnection({
    profile,
    command: "node",
    environment: {},
    buildArgs(input) {
      built = { prompt: input.task.prompt, threadId: input.continuation?.providerSessionRef };
      return ["--fake-worker"];
    },
    spawnWorker(command, args) {
      void command;
      void args;
      const output: ((chunk: string) => void)[] = [];
      const exits: ((code: number | null) => void)[] = [];
      const worker = {
        stdout: { on(_event: "data", listener: (chunk: Buffer | string) => void) { output.push((chunk) => listener(chunk)); } },
        on(event: "exit" | "error", listener: (arg: never) => void) {
          if (event === "exit") exits.push(listener as unknown as (code: number | null) => void);
        },
        kill() { exits.forEach((listener) => listener(null)); },
      };
      setTimeout(() => {
        const lines = [
          { type: "thread.started", thread_id: "thread-1" },
          { type: "item.started", item: { type: "m9r_tool_call", name: "m9r_computer_observe" } },
          { type: "item.completed", item: { type: "agent_message", text: "codex result" } },
          { type: "turn.completed" },
        ];
        lines.forEach((line) => output.forEach((listener) => listener(JSON.stringify(line) + "\n")));
        exits.forEach((listener) => listener(0));
      }, 0);
      return worker as never;
    },
  });

  const ready = await connection.start();
  const events: unknown[] = [];
  for await (const event of connection.send(task(profile, ready.generation, "T-codex-adapter"))) events.push(event);

  assert.equal(built?.prompt, "read-only adapter smoke test");
  assert.equal(built?.threadId, undefined);
  assert.equal(events.some((event) => (event as { kind?: string }).kind === "tool"), true);
  assert.equal(events.some((event) => (event as { kind?: string; text?: string }).text === "codex result"), true);
  assert.equal(connection.status().status, "ready");
});

test("OpenCode adapter keeps ACP at the edge and maps its events to the shared contract", async () => {
  const profile = normalizeManagedProviderProfile({ handle: "opencode", provider: "opencode", cwd: "C:/Work/Project" });
  let prompts = 0;
  let closed = false;
  const connection = createOpenCodeManagedProviderConnection({
    profile,
    exe: "opencode.exe",
    environment: {},
    missionId: "room-1",
    runtimeFactory: () => ({
      alive: () => true,
      ready: async () => ({ sessionId: "ses-opencode-1" }),
      async *prompt() {
        prompts += 1;
        yield { type: "provider.activity", sessionId: "ses-opencode-1", occurredAt: new Date().toISOString(), payload: { activityKind: "m9r_computer_observe" } };
        yield { type: "provider.reply_text", sessionId: "ses-opencode-1", occurredAt: new Date().toISOString(), payload: { text: "opencode result" } };
        yield { type: "provider.completed", sessionId: "ses-opencode-1", occurredAt: new Date().toISOString(), payload: {} };
      },
      cancelTurn: async () => undefined,
      close: () => { closed = true; },
    }),
  });

  const ready = await connection.start();
  const events: unknown[] = [];
  for await (const event of connection.send(task(profile, ready.generation, "T-opencode-adapter"))) events.push(event);

  assert.equal(prompts, 1);
  assert.equal(events.some((event) => (event as { kind?: string }).kind === "tool"), true);
  assert.equal(events.some((event) => (event as { kind?: string; text?: string }).text === "opencode result"), true);
  await connection.stop();
  assert.equal(closed, true);
});
