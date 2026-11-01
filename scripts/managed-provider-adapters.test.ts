import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createClaudeManagedProviderConnection,
  createCodexAppServerManagedProviderConnection,
  createCodexManagedProviderConnection,
  type CodexWorkerProcess,
} from "../src/lib/native/managed-provider-adapters";

/** A fake Claude stream-json process that answers control requests the way Claude Code 2.1.283 does. */
function fakeClaude(knownModels: string[]) {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  const written: Array<Record<string, unknown>> = [];
  const reply = (line: unknown) => setImmediate(() => stdout.emit("data", `${JSON.stringify(line)}\n`));
  const child = Object.assign(proc, {
    stdin: {
      write(chunk: string) {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as { type: string; request_id: string; request: { subtype: string; model?: string } };
          written.push(message as unknown as Record<string, unknown>);
          if (message.type !== "control_request") continue;
          if (message.request.subtype === "initialize") {
            reply({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {
              models: knownModels.map((value) => ({ value, displayName: value.toUpperCase(), supportedEffortLevels: ["low", "high", "xhigh"] })),
            } } });
          } else if (message.request.subtype === "set_model") {
            reply(knownModels.includes(message.request.model ?? "")
              ? { type: "control_response", response: { subtype: "success", request_id: message.request_id } }
              : { type: "control_response", response: { subtype: "error", request_id: message.request_id, error: `Model '${message.request.model}' not found` } });
          }
        }
        return true;
      },
      end() { return undefined; },
    },
    stdout,
    stderr: new EventEmitter(),
    kill() { proc.emit("exit", 0); return true; },
  });
  return { child, written };
}

test("Claude reports its own live model catalog and switches models on the running process", async () => {
  const fake = fakeClaude(["default", "opus", "sonnet"]);
  const connection = createClaudeManagedProviderConnection({
    profile: { connectionId: "m9r:claude:test", handle: "claude", provider: "claude-code", cwd: "C:/RunLeak/runleak" },
    mcpConfigPath: "C:/RunLeak/runleak/.mcp.json",
    environment: {},
    spawn: () => fake.child as never,
  });
  await connection.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const capabilities = connection.capabilities();
  assert.deepEqual(capabilities.models?.map((model) => model.id), ["default", "opus", "sonnet"]);
  assert.equal(capabilities.currentModel, "default");
  assert.deepEqual(capabilities.models?.[1].efforts?.map((effort) => effort.label), ["Low", "High", "Extra high"]);

  assert.deepEqual(await connection.applyModelSelection({ model: "sonnet" }), { ok: true, applies: "next-turn" });
  assert.equal(connection.capabilities().currentModel, "sonnet");
  assert.ok(fake.written.some((line) => (line.request as { subtype?: string; model?: string } | undefined)?.model === "sonnet"));

  const refused = await connection.applyModelSelection({ model: "not-in-catalog" });
  assert.equal(refused.ok, false, "a model outside the reported catalog is refused before reaching Claude");
  assert.equal(connection.capabilities().currentModel, "sonnet");
  await connection.stop();
});

function profile() {
  return { connectionId: "m9r:codex:test", handle: "codex", provider: "codex", cwd: "C:/RunLeak/runleak" } as const;
}

test("Codex worker failure retains bounded redacted stderr in the provider error", async () => {
  const workers: Array<EventEmitter & CodexWorkerProcess> = [];
  const connection = createCodexManagedProviderConnection({
    profile: profile(),
    command: "node",
    environment: {},
    buildArgs: () => [],
    spawnWorker: () => {
      const worker = new EventEmitter() as EventEmitter & CodexWorkerProcess;
      worker.stdout = new EventEmitter() as never;
      worker.stderr = new EventEmitter() as never;
      worker.kill = () => undefined;
      workers.push(worker);
      return worker;
    },
  });

  await connection.start();
  const iterator = connection.send({
    taskId: "T-diagnostic",
    connectionId: profile().connectionId,
    handle: profile().handle,
    provider: profile().provider,
    cwd: profile().cwd,
    generation: connection.status().generation,
    prompt: "diagnose the provider",
  })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "status");
  const worker = workers[0]!;
  (worker.stderr as unknown as EventEmitter).emit("data", Buffer.from("thread/start: the Codex app-server is not running\n"));
  worker.emit("exit", 1);

  const events: Array<{ kind: string; error?: string }> = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value as { kind: string; error?: string });
  }
  const failure = events.find((event) => event.kind === "error");
  assert.match(failure?.error ?? "", /Codex worker exited with code 1/);
  assert.match(failure?.error ?? "", /thread\/start: the Codex app-server is not running/);
});

test("the managed Codex app-server is one persistent process and one resumable session across turns", async () => {
  let launches = 0;
  let sessions = 0;
  let prompts = 0;
  const fake = {
    async launchServer() { launches += 1; return { serverId: "server-1", adapterId: "codex-app-server" }; },
    getServerHealth() { return { state: "alive" as const, detail: "alive" }; },
    async initialize() { return { protocolVersion: "codex-app-server", agentName: "codex", capabilities: {} }; },
    async createSession() { sessions += 1; return { sessionId: "session-1", providerSessionRef: "thread-1" }; },
    async resumeSession() { sessions += 1; return { sessionId: "session-1", providerSessionRef: "thread-1" }; },
    async *prompt() { prompts += 1; yield { type: "provider.reply_text", sessionId: "session-1", occurredAt: new Date().toISOString(), payload: { text: "ok" } }; yield { type: "provider.completed", sessionId: "session-1", occurredAt: new Date().toISOString(), payload: { stopReason: "end_turn" } }; },
    async cancelTurn() {},
    async shutdown() {},
  };
  const managed = createCodexAppServerManagedProviderConnection({
    profile: profile(), command: "codex", environment: {}, missionId: "room-1", promptPrefix: "M9R",
    adapterFactory: () => fake as never,
  });
  await managed.start();
  const task = (id: string) => ({ taskId: id, connectionId: profile().connectionId, handle: profile().handle, provider: profile().provider, cwd: profile().cwd, generation: managed.status().generation, prompt: "say ok" });
  const collect = async (id: string) => { const events = []; for await (const event of managed.send(task(id))) events.push(event); return events; };
  assert.equal((await collect("T-app-1")).at(-1)?.kind, "status");
  assert.equal((await collect("T-app-2")).at(-1)?.kind, "status");
  assert.equal(launches, 1);
  assert.equal(sessions, 1);
  assert.equal(prompts, 2);
  await managed.stop();
});

test("the managed Codex app-server restarts cold without resuming a provider thread", async () => {
  let launches = 0;
  let creates = 0;
  let resumes = 0;
  const fake = {
    async launchServer() { launches += 1; return { serverId: `server-${launches}`, adapterId: "codex-app-server" }; },
    getServerHealth() { return { state: "alive" as const, detail: "alive" }; },
    async initialize() { return { protocolVersion: "codex-app-server", agentName: "codex", capabilities: {} }; },
    async createSession() { creates += 1; return { sessionId: "session-1", providerSessionRef: "thread-1" }; },
    async resumeSession(input: { providerSessionRef: string }) { resumes += 1; assert.equal(input.providerSessionRef, "thread-1"); return { sessionId: "session-2", providerSessionRef: "thread-1" }; },
    async *prompt() { yield { type: "provider.completed", sessionId: "session-2", occurredAt: new Date().toISOString(), payload: { stopReason: "end_turn" } }; },
    async cancelTurn() {},
    async shutdown() {},
  };
  const managed = createCodexAppServerManagedProviderConnection({
    profile: profile(), command: "codex", environment: {}, missionId: "room-1", promptPrefix: "M9R",
    adapterFactory: () => fake as never,
  });
  await managed.start();
  assert.equal(creates, 1);
  await managed.stop();
  await managed.start({ providerSessionRef: "thread-1" });
  assert.equal(launches, 2);
  assert.equal(creates, 2);
  assert.equal(resumes, 0);
  await managed.stop();
});

test("an idle Codex app-server exit becomes failed so the next dispatch can recover it", async () => {
  let alive = true;
  let launches = 0;
  let resumes = 0;
  const fake = {
    async launchServer() { launches += 1; return { serverId: `server-${launches}`, adapterId: "codex-app-server" }; },
    getServerHealth() { return alive ? { state: "alive" as const, detail: "alive" } : { state: "dead" as const, detail: "Codex app-server not running" }; },
    async initialize() { return { protocolVersion: "codex-app-server", agentName: "codex", capabilities: {} }; },
    async createSession() { return { sessionId: "session-1", providerSessionRef: "thread-1" }; },
    async resumeSession() { resumes += 1; return { sessionId: "session-2", providerSessionRef: "thread-1" }; },
    async *prompt() { yield { type: "provider.completed", sessionId: "session-2", occurredAt: new Date().toISOString(), payload: { stopReason: "end_turn" } }; },
    async cancelTurn() {},
    async shutdown() {},
  };
  const managed = createCodexAppServerManagedProviderConnection({
    profile: profile(), command: "codex", environment: {}, missionId: "room-1", promptPrefix: "M9R",
    adapterFactory: () => fake as never,
  });
  await managed.start();
  alive = false;
  const task = { taskId: "T-idle-crash", connectionId: profile().connectionId, handle: profile().handle, provider: profile().provider, cwd: profile().cwd, generation: managed.status().generation, prompt: "recover" };
  await assert.rejects(async () => { for await (const _event of managed.send(task)) { /* the health gate throws before a turn starts */ } }, /Codex app-server not running/);
  assert.equal(managed.status().status, "failed");
  alive = true;
  await managed.start({ providerSessionRef: "thread-1" });
  assert.equal(launches, 2);
  assert.equal(resumes, 0);
  await managed.stop();
});

test("managed Codex app-server failures retain an explicit failure class", async () => {
  const fake = {
    async launchServer() { return { serverId: "server-1", adapterId: "codex-app-server" }; },
    getServerHealth() { return { state: "alive" as const, detail: "alive" }; },
    async initialize() { return { protocolVersion: "codex-app-server", agentName: "codex", capabilities: {} }; },
    async createSession() { return { sessionId: "session-1", providerSessionRef: "thread-1" }; },
    async resumeSession() { return { sessionId: "session-1", providerSessionRef: "thread-1" }; },
    async *prompt() { yield { type: "provider.failed", sessionId: "session-1", occurredAt: new Date().toISOString(), payload: { reason: "thread/resume already has an active writer" } }; },
    async cancelTurn() {},
    async shutdown() {},
  };
  const managed = createCodexAppServerManagedProviderConnection({
    profile: profile(), command: "codex", environment: {}, missionId: "room-1", promptPrefix: "M9R",
    adapterFactory: () => fake as never,
  });
  await managed.start();
  const events = [];
  for await (const event of managed.send({ taskId: "T-app-fail", connectionId: profile().connectionId, handle: profile().handle, provider: profile().provider, cwd: profile().cwd, generation: managed.status().generation, prompt: "fail" })) events.push(event);
  const failure = events.find((event) => event.kind === "error");
  assert.match(failure?.error ?? "", /active-writer/);
  await managed.stop();
});
