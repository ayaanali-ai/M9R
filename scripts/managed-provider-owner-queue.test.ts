import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedProviderOwner } from "@/lib/native/managed-provider-owner";
import { createLocalStore } from "@/lib/native/local-store";
import type {
  ManagedProviderConnection,
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderEvent,
  ManagedProviderModelApply,
  ManagedProviderTask,
} from "@/lib/native/managed-provider-contract";

/** A connection whose `send` blocks on a gate the test controls, so a turn can be held "active"
 * long enough to queue a follow-up message and then stop/pause before letting it finish. */
function gatedConnection(profile: ManagedProviderConnectionProfile) {
  let generation = 0;
  let status: ManagedProviderConnectionSnapshot["status"] = "stopped";
  let release = () => {};
  let gate: Promise<void> | undefined = new Promise<void>((resolve) => { release = resolve; });
  const modelApply: ManagedProviderModelApply = { ok: true, applies: "next-turn" };
  const sent: ManagedProviderTask[] = [];
  const connection: ManagedProviderConnection = {
    profile,
    start: async () => { generation += 1; status = "ready"; return { connectionId: profile.connectionId, generation }; },
    send: async function* (task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent> {
      sent.push(task);
      yield { kind: "accepted" };
      if (gate) await gate;
      yield { kind: "result", text: "done", isError: false };
    },
    interrupt: async () => undefined,
    cancel: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    status: () => ({ ...profile, status, generation }),
    readiness: () => ({ healthy: status === "ready" }),
    capabilities: () => ({ connectionId: profile.connectionId, provider: profile.provider, generation, models: [], currentModel: null, currentEffort: null }),
    applyModelSelection: async () => modelApply,
    continuation: () => undefined,
    drain: async () => undefined,
    stop: async () => { status = "stopped"; },
  };
  return {
    connection,
    sent,
    /** Hold the next/current turn's `send` open until `release()` is called. */
    holdOpen() { gate = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release(); },
  };
}

test("a provider turn ending without a completion report preserves unfinished M9R work", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-incomplete-"));
  const store = createLocalStore(root);
  let gated: ReturnType<typeof gatedConnection> | undefined;
  const owner = createManagedProviderOwner({ agents: [{ handle: "codex", provider: "codex", folder: root }], storeRoot: root,
    repoRoot: root, brokerPort: 0, store, env: {}, createConnection: (profile) => (gated = gatedConnection(profile)).connection });
  try {
    assert.equal(owner.deliver("codex", "Verify both documents.").ok, true);
    for (let attempt = 0; attempt < 100 && !gated?.sent.length; attempt++) await new Promise((done) => setTimeout(done, 10));
    gated!.release();
    for (let attempt = 0; attempt < 100 && store.getTask("T1")?.receipt?.state !== "paused"; attempt++) await new Promise((done) => setTimeout(done, 10));
    const task = store.getTask("T1")!;
    assert.equal(task.receipt?.state, "paused");
    assert.equal(task.resultSummary, undefined);
    assert.deepEqual(task.completion?.remainingWork, ["Verify both documents."]);
    assert.match(gated!.sent[0]!.prompt, /Ending the provider turn alone never completes/);
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("an error result is durably failed and is not counted as a first action", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-result-error-"));
  const store = createLocalStore(root);
  const owner = createManagedProviderOwner({ agents: [{ handle: "codex", provider: "codex", folder: root }], storeRoot: root,
    repoRoot: root, brokerPort: 0, store, env: {}, verifiedRuntimeBuildId: "cd".repeat(32), createConnection: (profile) => {
      const connection: ManagedProviderConnection = {
        profile,
        start: async () => ({ connectionId: profile.connectionId, generation: 1 }),
        send: async function* () {
          yield { kind: "accepted" };
          yield { kind: "text", text: "Provider is reporting a request error." };
          yield { kind: "result", text: "API rejected the tool schema.", isError: true };
        },
        interrupt: async () => undefined,
        cancel: async () => undefined,
        pause: async () => undefined,
        resume: async () => undefined,
        status: () => ({ ...profile, status: "ready", generation: 1 }),
        readiness: () => ({ healthy: true }),
        capabilities: () => ({ connectionId: profile.connectionId, provider: profile.provider, generation: 1, models: [], currentModel: null, currentEffort: null }),
        applyModelSelection: async () => ({ ok: true, applies: "next-turn" }),
        continuation: () => undefined,
        drain: async () => undefined,
        stop: async () => undefined,
      };
      return connection;
    } });
  try {
    const delivery = owner.deliver("codex", "Run the assigned check.");
    assert.equal(delivery.ok, true, JSON.stringify(delivery));
    for (let attempt = 0; attempt < 100 && store.getTask("T1")?.receipt?.state !== "failed"; attempt++) await new Promise((done) => setTimeout(done, 10));
    const task = store.getTask("T1")!;
    assert.equal(task.receipt?.state, "failed");
    assert.equal(task.delivery?.state, "failed");
    assert.match(task.receipt?.error ?? "", /API rejected the tool schema/);
    assert.deepEqual(task.runtimeBuildIds, ["cd".repeat(32)], "the executing verified runtime is attached to task evidence");
    assert.equal(task.stageTiming?.some((event) => event.phase === "first-visible-action"), false,
      "provider prose and a terminal result are not a UI action");
    assert.equal(task.stageTiming?.find((event) => event.phase === "completion")?.status, "error");
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("an A2A provider error is durably failed with build evidence, not left as accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-room-error-"));
  const store = createLocalStore(root);
  const task = store.addTask({ from: "web-codex", to: "claude", goal: "Calculate and report the result.", origin: "agent_initiated", idempotencyKey: "room-error" }).task;
  const events: unknown[] = [];
  const owner = createManagedProviderOwner({
    agents: [{ handle: "claude", provider: "claude-code", folder: root }], storeRoot: root,
    repoRoot: root, brokerPort: 0, store, env: {}, verifiedRuntimeBuildId: "ef".repeat(32), onEvent: (event) => events.push(event),
    createConnection: (profile) => {
      const connection: ManagedProviderConnection = {
        profile,
        start: async () => ({ connectionId: profile.connectionId, generation: 1 }),
        send: async function* () {
          yield { kind: "accepted" };
          yield { kind: "result", text: "API rejected the MCP tool schema.", isError: true };
        },
        interrupt: async () => undefined,
        cancel: async () => undefined,
        pause: async () => undefined,
        resume: async () => undefined,
        status: () => ({ ...profile, status: "ready", generation: 1 }),
        readiness: () => ({ healthy: true }),
        capabilities: () => ({ connectionId: profile.connectionId, provider: profile.provider, generation: 1, models: [], currentModel: null, currentEffort: null }),
        applyModelSelection: async () => ({ ok: true, applies: "next-turn" }),
        continuation: () => undefined,
        drain: async () => undefined,
        stop: async () => undefined,
      };
      return connection;
    },
  });
  try {
    assert.equal(owner.deliver("claude", "Run the assigned check.", task.id).ok, true);
    for (let attempt = 0; attempt < 100 && store.getTask(task.id)?.receipt?.state !== "failed"; attempt++) await new Promise((done) => setTimeout(done, 10));
    const failed = store.getTask(task.id)!;
    assert.equal(failed.receipt?.state, "failed", JSON.stringify({ failed, events }));
    assert.equal(failed.lifecycle?.state, "failed", "A2A tasks use task lifecycle rather than owner transport receipts");
    assert.match(failed.receipt?.error ?? "", /API rejected the MCP tool schema/);
    assert.deepEqual(failed.runtimeBuildIds, ["ef".repeat(32)]);
    assert.equal(failed.resultSummary, undefined, "a provider error is never exposed as a successful answer");
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("managed provider bridge returns A2A results to the pinned sender session", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-a2a-roundtrip-"));
  const store = createLocalStore(root);
  const tokens = new Map<string, string>();
  const sessions = new Map<string, string>();
  const prompts = new Map<string, string[]>();
  const owner = createManagedProviderOwner({
    agents: [
      { handle: "claude", provider: "claude-code", folder: root },
      { handle: "codex", provider: "codex", folder: root },
    ],
    storeRoot: root,
    repoRoot: root,
    brokerPort: 0,
    store,
    env: {},
    createConnection: (profile, context) => {
      tokens.set(profile.handle, context.token);
      sessions.set(profile.handle, context.sessionId);
      prompts.set(profile.handle, []);
      const connection: ManagedProviderConnection = {
        profile,
        start: async () => ({ connectionId: profile.connectionId, generation: 1 }),
        send: async function* (task) {
          prompts.get(profile.handle)!.push(task.prompt);
          yield { kind: "accepted" };
          yield { kind: "result", text: "Provider turn ended after its teammate message.", isError: false };
        },
        interrupt: async () => undefined,
        cancel: async () => undefined,
        pause: async () => undefined,
        resume: async () => undefined,
        status: () => ({ ...profile, status: "ready", generation: 1 }),
        readiness: () => ({ healthy: true }),
        capabilities: () => ({ connectionId: profile.connectionId, provider: profile.provider, generation: 1, models: [], currentModel: null, currentEffort: null }),
        applyModelSelection: async () => ({ ok: true, applies: "next-turn" }),
        continuation: () => undefined,
        drain: async () => undefined,
        stop: async () => undefined,
      };
      return connection;
    },
  });
  const waitFor = async (predicate: () => boolean, description: string) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(predicate(), true, `timed out waiting for ${description}`);
  };
  try {
    assert.deepEqual((await owner.start()).failures, []);
    const request = store.addTask({
      from: "claude", to: "codex", goal: "Check the value and return it.", origin: "agent_initiated",
      fromSession: sessions.get("claude"), targetSession: sessions.get("codex"),
      standingRuleApplies: true, idempotencyKey: "managed-a2a-roundtrip",
    }).task;
    store.setDelivery(request.id, { state: "deferred" });
    await waitFor(() => !!store.getTask(request.id)?.deliveredAt, "the incoming teammate request to reach Codex");
    assert.match(prompts.get("codex")?.join("\n") ?? "", new RegExp(request.id));

    const recorded = store.recordTaskResult(tokens.get("codex")!, request.id, "The value is 42.", {
      status: "completed", remainingWork: [],
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.answerDelivery, "queued");
    assert.ok(recorded.answerTaskId);
    await waitFor(() => !!store.getTask(recorded.answerTaskId!)?.deliveredAt, "the result reply to reach Claude");
    const returnedPrompt = prompts.get("claude")?.join("\n") ?? "";
    assert.match(returnedPrompt, new RegExp(request.id));
    assert.match(returnedPrompt, /The value is 42/);
    assert.equal(store.getTask(request.id)?.answerPushedAt !== undefined, true,
      "answer presentation is recorded only after the exact pinned sender receives it");
    assert.equal(store.getTask(recorded.answerTaskId!)?.deliveredSession, sessions.get("claude"));

    const wrongSession = store.addTask({
      from: "codex", to: "claude", goal: "Do not deliver to another session.", origin: "agent_initiated",
      fromSession: sessions.get("codex"), targetSession: "inactive-claude-session",
      standingRuleApplies: true, idempotencyKey: "managed-a2a-wrong-session",
    }).task;
    store.setDelivery(wrongSession.id, { state: "deferred" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(store.getTask(wrongSession.id)?.deliveredAt, undefined,
      "a targeted teammate task waits instead of spilling into a different provider session");
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode keeps the user's credential data home while isolating M9R tool policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-opencode-home-"));
  const ownerData = join(root, "owner-opencode-data");
  const ownerCache = join(root, "owner-opencode-cache");
  const store = createLocalStore(root);
  let capturedEnv: Record<string, string | undefined> | undefined;
  const owner = createManagedProviderOwner({
    agents: [{ handle: "opencode", provider: "opencode", folder: root }],
    storeRoot: root,
    repoRoot: root,
    brokerPort: 0,
    store,
    env: { XDG_DATA_HOME: ownerData, XDG_CACHE_HOME: ownerCache, M9R_OPENCODE_MODEL: "openai/gpt-6.1-sol" },
    opencodeExe: () => "opencode",
    openCodeRuntime: ({ env, model }) => {
      capturedEnv = env;
      assert.equal(model, "openai/gpt-6.1-sol", "the documented M9R model override reaches the managed owner runtime");
      return {
        async ready() { return { sessionId: "opencode-test-session" }; },
        alive() { return true; },
        async *prompt() { yield { type: "provider.completed", sessionId: "opencode-test-session", occurredAt: new Date().toISOString(), payload: {} }; },
        async cancelTurn() {},
        close() {},
      } as never;
    },
  });
  try {
    const started = await owner.start();
    assert.deepEqual(started.failures, []);
    assert.equal(capturedEnv?.XDG_DATA_HOME, ownerData, "OpenCode auth/account data is not hidden in a new M9R directory");
    assert.equal(capturedEnv?.XDG_CACHE_HOME, ownerCache);
    assert.notEqual(capturedEnv?.XDG_CONFIG_HOME, root, "M9R continues to isolate its provider tool-policy config");
    assert.match(capturedEnv?.XDG_CONFIG_HOME ?? "", /managed-provider-sessions/);
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("explicit new work gets its own context and leaves the prior paused work intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-new-work-"));
  const store = createLocalStore(root);
  let gated: ReturnType<typeof gatedConnection> | undefined;
  const owner = createManagedProviderOwner({ agents: [{ handle: "codex", provider: "codex", folder: root }], storeRoot: root,
    repoRoot: root, brokerPort: 0, store, env: {}, createConnection: (profile) => (gated = gatedConnection(profile)).connection });
  try {
    owner.deliver("codex", "Inspect the report.");
    for (let attempt = 0; attempt < 100 && !gated?.sent.length; attempt++) await new Promise((done) => setTimeout(done, 10));
    owner.stop("codex"); gated!.release();
    for (let attempt = 0; attempt < 100 && owner.snapshot()[0]?.status === "working"; attempt++) await new Promise((done) => setTimeout(done, 10));
    gated!.holdOpen();
    owner.deliver("codex", "New task: inspect another document.");
    for (let attempt = 0; attempt < 100 && gated!.sent.length < 2; attempt++) await new Promise((done) => setTimeout(done, 10));
    assert.equal(store.getTask("T2")?.logicalContext?.workId, "T2");
    assert.equal(store.getTask("T2")?.logicalContext?.control, "new-task");
    assert.equal(store.getTask("T1")?.receipt?.state, "paused");
    gated!.release();
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("stopping an agent drops its queued follow-up, so the very next message runs instead of a stale one", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-queue-"));
  const store = createLocalStore(root);
  let gated: ReturnType<typeof gatedConnection> | undefined;

  const owner = createManagedProviderOwner({
    agents: [{ handle: "codex", provider: "codex", folder: root }],
    storeRoot: root,
    repoRoot: root,
    brokerPort: 0,
    store,
    env: {},
    createConnection: (profile) => (gated = gatedConnection(profile)).connection,
    onEvent: (event) => { if (process.env.M9R_TEST_DEBUG) console.log("EVENT", JSON.stringify(event)); },
  });

  try {
    // Turn A starts; the fake connection is held ("working") until released.
    const first = owner.deliver("codex", "A: do the first thing");
    assert.equal((await first).ok, true, JSON.stringify(first));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // B arrives while A is still active -> queued behind A, and A's turn is interrupted.
    const second = await owner.deliver("codex", "B: do the second thing");
    assert.equal(second.ok, true);
    assert.equal((second as { mode: string }).mode, "interrupted");

    // The owner now says stop. This must drop B -- B is exactly the stale message the
    // owner is trying to get away from, not what they want to run next.
    owner.stop("codex");

    // Let A's turn actually finish draining now that it has been fenced/interrupted.
    gated!.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A fresh message C should run next, not stale queued B or unrelated paused A context.
    gated!.holdOpen();
    const third = await owner.deliver("codex", "C: do the real next thing");
    assert.equal(third.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Tasks are assigned sequential ids (T1=A, T2=B, T3=C) in a fresh store.
    const taskC = store.getTask?.("T3");
    assert.equal(taskC?.logicalContext?.workId, "T3");
    assert.equal(taskC?.logicalContext?.control, "new-task");
    assert.equal(taskC?.logicalContext?.latestInstruction, "C: do the real next thing");
    assert.equal(taskC?.goal, "C: do the real next thing", "C must have been delivered as the third task");
    assert.ok(["queued", "done"].includes(taskC?.delivery?.state ?? ""), "sanity: C actually reached provider delivery");

    const taskB = store.getTask?.("T2");
    assert.equal(taskB?.goal, "B: do the second thing");
    assert.equal(taskB?.receipt?.state, "canceled", "B must be canceled by the stop, not silently started later");

    gated!.release();
  } finally {
    await owner.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit resume starts a new turn with durable M9R context and no provider resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-resume-"));
  const store = createLocalStore(root);
  let gated: ReturnType<typeof gatedConnection> | undefined;
  const owner = createManagedProviderOwner({
    agents: [{ handle: "codex", provider: "codex", folder: root }], storeRoot: root,
    repoRoot: root, brokerPort: 0, store, env: {},
    createConnection: (profile) => (gated = gatedConnection(profile)).connection,
  });
  try {
    assert.equal(owner.deliver("codex", "Inspect the report before changing anything.").ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    owner.stop("codex");
    gated!.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    gated!.holdOpen();
    assert.equal(owner.resume?.("codex"), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = store.getTask("T2");
    assert.equal(resumed?.logicalContext?.workId, "T1");
    assert.equal(resumed?.logicalContext?.control, "continuation");
    assert.equal(resumed?.logicalContext?.latestInstruction, "Inspect the report before changing anything.");
    assert.equal(store.getTask("T1")?.receipt?.state, "paused", "old transport receipt is never replayed");
    assert.equal(gated!.sent.length, 2);
    assert.match(gated!.sent[1].prompt, /M9R logical task context/);
    assert.match(gated!.sent[1].prompt, /Reobserve the current surface/);
    assert.doesNotMatch(gated!.sent[1].prompt, /--resume|providerSessionRef/);
    gated!.release();
  } finally { await owner.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
