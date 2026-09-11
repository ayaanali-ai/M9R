import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeSessionRegistry,
} from "@/lib/bridge/bridge-session-registry";
import { interactiveCapabilityAvailable } from "@/lib/bridge/interactive-provider-adapter";
import { AcpSessionController } from "@/lib/bridge/acp-client";
import { AcpProviderRegistry } from "@/lib/bridge/acp-provider-registry";
import { createDefaultAcpProviderRegistry } from "@/lib/bridge/acp-provider-registry";
import { InMemoryMissionBridgeStore } from "@/lib/bridge/bridge-store";
import { BRIDGE_PROTOCOL_VERSION, validateBridgeHeartbeat } from "@/lib/bridge/bridge-protocol";

const base = {
  sessionId: "session-1",
  bridgeInstanceId: "bridge-1",
  workspaceId: "workspace-1",
  missionId: "mission-1",
  participantId: "agent-a",
  providerAdapterId: "codex-acp",
  providerSessionRef: null,
  capabilities: {
    interactive_session: true,
    session_resume: true,
    mid_turn_steering: false,
  },
};

test("Bridge session lifecycle transitions are explicit and irreversible in order", () => {
  const registry = new BridgeSessionRegistry();
  const session = registry.register(base);
  assert.equal(session.state, "registered");
  for (const state of ["launching", "initializing", "ready", "working"] as const) {
    assert.equal(registry.transition(session.sessionId, state).ok, true);
  }
  assert.equal(registry.transition(session.sessionId, "registered").ok, false);
});

test("Bridge capability checks are explicit and do not default to support", () => {
  assert.equal(interactiveCapabilityAvailable(base.capabilities, "interactive_session"), true);
  assert.equal(interactiveCapabilityAvailable(base.capabilities, "file_event_reporting"), false);
  assert.equal(interactiveCapabilityAvailable({}, "interactive_session"), false);
});

test("ACP session launch is fail-closed while the feature flag is disabled", async () => {
  let launched = false;
  const controller = new AcpSessionController(new BridgeSessionRegistry(), { ACP_BRIDGE_ENABLED: "false" });
  const result = await controller.start({
    adapter: {
      id: "test-acp",
      discoverCapabilities: async () => ({}) as never,
      launchServer: async () => { launched = true; throw new Error("must not launch"); },
      initialize: async () => { throw new Error("must not initialize"); },
      createSession: async () => { throw new Error("must not create"); },
      resumeSession: async () => { throw new Error("must not resume"); },
      prompt: async function* () { /* no-op */ },
      cancelTurn: async () => {},
      respondToPermission: async () => {},
      closeSession: async () => {},
      shutdown: async () => {},
    },
    assignment: { missionId: "mission-1", dispatchKey: "primary", goal: "task", executionConstraints: {} },
    environment: { workingDirectory: "/tmp/worktree", kind: "disposable" },
    session: { ...base, providerSessionRef: null },
  });
  assert.deepEqual(result, { ok: false, reason: "acp_bridge_disabled" });
  assert.equal(launched, false);
});

test("ACP prompt events are delivered to the configured runtime sink with Mission identity", async () => {
  const sinkEvents: Array<{ executionId: string; assignmentId: string | null; eventType: string }> = [];
  const adapter = {
    id: "test-acp",
    discoverCapabilities: async () => ({}) as never,
    launchServer: async () => ({ serverId: "server-1", adapterId: "test-acp" }),
    initialize: async () => ({ protocolVersion: "1", agentName: "test", capabilities: { interactive_session: true } }) as never,
    createSession: async () => ({ sessionId: "provider-session-1", providerSessionRef: "provider-ref-1" }),
    resumeSession: async () => ({ sessionId: "provider-session-1", providerSessionRef: "provider-ref-1" }),
    prompt: async function* () {
      yield { type: "provider.activity", sessionId: "provider-session-1", occurredAt: "2026-08-01T00:00:00.000Z", payload: { type: "provider.activity", activityKind: "file.read", status: "started", summary: "Read a source file" } };
    },
    cancelTurn: async () => {},
    respondToPermission: async () => {},
    closeSession: async () => {},
    shutdown: async () => {},
  };
  const controller = new AcpSessionController(
    new BridgeSessionRegistry(),
    { ACP_BRIDGE_ENABLED: "true" },
    new AcpProviderRegistry(),
    async ({ executionId, assignmentId, event }) => { sinkEvents.push({ executionId, assignmentId, eventType: event.type }); },
  );
  const started = await controller.start({
    adapter,
    assignment: { missionId: "mission-1", dispatchKey: "primary", goal: "task", executionConstraints: {}, assignmentId: "assignment-1", participantId: "agent-a" },
    executionId: "execution-1",
    environment: { workingDirectory: "C:\\worktree", kind: "shared" },
    session: { ...base, providerSessionRef: null },
  });
  assert.equal(started.ok, true);
  const events = [];
  for await (const event of controller.prompt("session-1", "inspect")) events.push(event);
  assert.equal(events.length, 1);
  assert.deepEqual(sinkEvents, [{ executionId: "execution-1", assignmentId: "assignment-1", eventType: "provider.activity" }]);
  await controller.close("session-1");
});

test("ACP prompt events are not held behind a slow runtime sink", async () => {
  let releaseSink!: () => void;
  const sinkFinished = new Promise<void>((resolve) => { releaseSink = resolve; });
  const adapter = {
    id: "test-acp",
    discoverCapabilities: async () => ({}) as never,
    launchServer: async () => ({ serverId: "server-1", adapterId: "test-acp" }),
    initialize: async () => ({ protocolVersion: "1", agentName: "test", capabilities: { interactive_session: true } }) as never,
    createSession: async () => ({ sessionId: "provider-session-1", providerSessionRef: "provider-ref-1" }),
    resumeSession: async () => ({ sessionId: "provider-session-1", providerSessionRef: "provider-ref-1" }),
    prompt: async function* () {
      yield { type: "provider.progress", sessionId: "provider-session-1", occurredAt: "2026-08-01T00:00:00.000Z", payload: { type: "provider.progress", summary: "Progress" } };
    },
    cancelTurn: async () => {},
    respondToPermission: async () => {},
    closeSession: async () => {},
    shutdown: async () => {},
  };
  const controller = new AcpSessionController(
    new BridgeSessionRegistry(),
    { ACP_BRIDGE_ENABLED: "true" },
    new AcpProviderRegistry(),
    async () => sinkFinished,
  );
  const started = await controller.start({
    adapter,
    assignment: { missionId: "mission-1", dispatchKey: "primary", goal: "task", executionConstraints: {} },
    executionId: "execution-1",
    environment: { workingDirectory: "C:\\worktree", kind: "shared" },
    session: { ...base, providerSessionRef: null },
  });
  assert.equal(started.ok, true);

  const firstEvent = await Promise.race([
    (async () => {
      for await (const event of controller.prompt("session-1", "inspect")) return event;
      return null;
    })(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  releaseSink();
  await sinkFinished;
  await controller.close("session-1");
  assert.equal(firstEvent?.type, "provider.progress");
});

test("ACP controller restarts a dead provider server before the next turn and preserves the bridge session identity", async () => {
  let health: "alive" | "dead" = "alive";
  let launches = 0;
  let resumes = 0;
  const adapter = {
    id: "test-acp",
    discoverCapabilities: async () => ({}) as never,
    launchServer: async () => ({ serverId: `server-${++launches}`, adapterId: "test-acp" }),
    getServerHealth: () => ({ state: health, detail: health === "dead" ? "child exited" : "running" } as const),
    initialize: async () => ({ protocolVersion: "1", agentName: "test", capabilities: { interactive_session: true } }) as never,
    createSession: async () => ({ sessionId: "provider-session-new", providerSessionRef: "provider-ref-new" }),
    resumeSession: async () => { resumes += 1; return { sessionId: "provider-session-resumed", providerSessionRef: "provider-ref-resumed" }; },
    prompt: async function* (input: { session: { sessionId: string } }) {
      yield { type: "provider.progress", sessionId: input.session.sessionId, occurredAt: "2026-08-01T00:00:00.000Z", payload: { type: "provider.progress", summary: "Recovered" } };
    },
    cancelTurn: async () => {},
    respondToPermission: async () => {},
    closeSession: async () => {},
    shutdown: async () => { health = "dead"; },
  };
  const registry = new BridgeSessionRegistry();
  const controller = new AcpSessionController(registry, { ACP_BRIDGE_ENABLED: "true" }, new AcpProviderRegistry(), undefined, { recoveryBackoffMs: [0] });
  const started = await controller.start({
    adapter,
    assignment: { missionId: "mission-1", dispatchKey: "primary", goal: "task", executionConstraints: {} },
    executionId: "execution-1",
    environment: { workingDirectory: "C:\\worktree", kind: "shared" },
    session: { ...base, providerSessionRef: null },
  });
  assert.equal(started.ok, true);
  health = "dead";
  const events = [];
  for await (const event of controller.prompt("session-1", "continue")) events.push(event);
  assert.equal(events[0]?.type, "provider.progress");
  assert.equal(launches, 2);
  assert.equal(resumes, 1);
  assert.equal(registry.get("session-1")?.providerSessionRef, "provider-ref-resumed");
  assert.equal(registry.get("session-1")?.state, "ready");
  await controller.close("session-1");
});

test("ACP controller bounds one bridge to a finite provider session pool", async () => {
  let launches = 0;
  const adapter = {
    id: "test-acp",
    discoverCapabilities: async () => ({}) as never,
    launchServer: async () => ({ serverId: `server-${++launches}`, adapterId: "test-acp" }),
    initialize: async () => ({ protocolVersion: "1", agentName: "test", capabilities: { interactive_session: true } }) as never,
    createSession: async () => ({ sessionId: `provider-session-${launches}`, providerSessionRef: `provider-ref-${launches}` }),
    resumeSession: async () => ({ sessionId: "provider-session-resumed", providerSessionRef: "provider-ref-resumed" }),
    prompt: async function* () {},
    cancelTurn: async () => {},
    respondToPermission: async () => {},
    closeSession: async () => {},
    shutdown: async () => {},
  };
  const controller = new AcpSessionController(new BridgeSessionRegistry(), { ACP_BRIDGE_ENABLED: "true" }, new AcpProviderRegistry(), undefined, { maxActiveSessions: 1 });
  const first = await controller.start({ adapter, assignment: { missionId: "mission-1", dispatchKey: "one", goal: "task", executionConstraints: {} }, executionId: "execution-1", environment: { workingDirectory: "C:\\worktree", kind: "shared" }, session: { ...base, sessionId: "session-1", providerSessionRef: null } });
  const second = await controller.start({ adapter, assignment: { missionId: "mission-1", dispatchKey: "two", goal: "task", executionConstraints: {} }, executionId: "execution-2", environment: { workingDirectory: "C:\\worktree", kind: "shared" }, session: { ...base, sessionId: "session-2", providerSessionRef: null } });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "provider_session_pool_exhausted" });
  assert.equal(launches, 1);
  await controller.close("session-1");
});

test("controller.respondToPermission delivers a decision to the exact session that's actually waiting on it -- the fix for the permission gate that used to have no caller anywhere", async () => {
  const delivered: Array<{ sessionId: string; requestId: string; approved: boolean }> = [];
  const adapter = {
    id: "test-acp",
    discoverCapabilities: async () => ({}) as never,
    launchServer: async () => ({ serverId: "server-1", adapterId: "test-acp" }),
    initialize: async () => ({ protocolVersion: "1", agentName: "test", capabilities: { interactive_session: true } }) as never,
    createSession: async () => ({ sessionId: "provider-session-1", providerSessionRef: "provider-ref-1" }),
    resumeSession: async () => ({ sessionId: "provider-session-1", providerSessionRef: "provider-ref-1" }),
    prompt: async function* () { /* no-op */ },
    cancelTurn: async () => {},
    respondToPermission: async (input: { session: { sessionId: string }; requestId: string; approved: boolean }) => {
      delivered.push({ sessionId: input.session.sessionId, requestId: input.requestId, approved: input.approved });
    },
    closeSession: async () => {},
    shutdown: async () => {},
  };
  const controller = new AcpSessionController(new BridgeSessionRegistry(), { ACP_BRIDGE_ENABLED: "true" });
  const started = await controller.start({
    adapter,
    assignment: { missionId: "mission-1", dispatchKey: "primary", goal: "task", executionConstraints: {} },
    executionId: "execution-1",
    environment: { workingDirectory: "C:\\worktree", kind: "shared" },
    session: { ...base, providerSessionRef: null },
  });
  assert.equal(started.ok, true);

  await controller.respondToPermission("session-1", "permission-abc", true);
  assert.deepEqual(delivered, [{ sessionId: "provider-session-1", requestId: "permission-abc", approved: true }]);
});

test("controller.respondToPermission refuses a session id that isn't actually live", async () => {
  const controller = new AcpSessionController(new BridgeSessionRegistry());
  await assert.rejects(() => controller.respondToPermission("no-such-session", "permission-abc", true), /is not active/);
});

test("the default Bridge registry exposes the official ACP providers", () => {
  assert.deepEqual(createDefaultAcpProviderRegistry().list(), ["claude-agent-acp", "codex-acp", "opencode-acp"]);
});

test("official ACP providers expose the same normalized observability and control contract", async () => {
  const registry = createDefaultAcpProviderRegistry();
  for (const providerId of registry.list()) {
    const adapter = registry.get(providerId)!;
    const capabilities = await adapter.discoverCapabilities({ workspaceId: "workspace-1" });
    for (const capability of [
      "interactive_session",
      "streaming_output",
      "cancellation",
      "usage_reporting",
      "tool_event_reporting",
      "approval_requests",
      "repository_editing",
      "file_event_reporting",
      "command_event_reporting",
      "permission_event_reporting",
    ] as const) {
      assert.equal(capabilities[capability], true, `${providerId} must declare ${capability}`);
    }
    assert.equal(capabilities.plan_event_reporting, false);
  }
});

test("Bridge persistence keeps workspace ownership and refuses invalid session transitions", async () => {
  const store = new InMemoryMissionBridgeStore();
  const now = "2026-08-01T00:00:00.000Z";
  await store.registerInstance({
    id: "bridge-1",
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    repositoryId: "repo-1",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    softwareVersion: "test",
    supportedProviders: ["codex-acp"],
    now,
  });
  assert.equal(await store.heartbeatInstance({ id: "bridge-1", workspaceId: "other-workspace", now }), null);
  const session = await store.registerSession({
    ...base,
    now,
  });
  assert.equal(session.state, "registered");
  assert.equal((await store.transitionSession({ sessionId: session.sessionId, bridgeInstanceId: session.bridgeInstanceId, workspaceId: session.workspaceId, nextState: "working", now })), null);
  assert.equal((await store.transitionSession({ sessionId: session.sessionId, bridgeInstanceId: session.bridgeInstanceId, workspaceId: session.workspaceId, nextState: "launching", now }))?.state, "launching");
  assert.equal(await store.touchSessions({ bridgeInstanceId: "bridge-1", workspaceId: "workspace-1", sessionIds: ["session-1"], now }), 1);

  const firstCursor = await store.saveWorkspaceCursor({
    workspaceId: "workspace-1",
    bridgeInstanceId: "bridge-1",
    ownerId: "owner-1",
    conversationId: "conversation-1",
    cursorCreatedAt: "2026-08-01T00:00:01.000Z",
    cursorMessageId: "00000000-0000-0000-0000-000000000001",
    now,
  });
  const regressedCursor = await store.saveWorkspaceCursor({
    workspaceId: "workspace-1",
    bridgeInstanceId: "bridge-1",
    ownerId: "owner-1",
    conversationId: "conversation-1",
    cursorCreatedAt: "2026-08-01T00:00:00.000Z",
    cursorMessageId: "00000000-0000-0000-0000-000000000002",
    now,
  });
  assert.equal(regressedCursor.cursorMessageId, firstCursor.cursorMessageId);
  assert.equal((await store.getWorkspaceCursor({ workspaceId: "workspace-1", bridgeInstanceId: "bridge-1", ownerId: "other-owner", conversationId: "conversation-1" })), null);
});

test("Bridge heartbeat validation is bounded and timestamp-aware", () => {
  assert.equal(validateBridgeHeartbeat({ protocolVersion: BRIDGE_PROTOCOL_VERSION, bridgeInstanceId: "bridge-1", sequence: 1, sentAt: "2026-08-01T00:00:00.000Z", activeSessionIds: ["session-1"] }), true);
  assert.equal(validateBridgeHeartbeat({ protocolVersion: BRIDGE_PROTOCOL_VERSION, bridgeInstanceId: "bridge-1", sequence: 1, sentAt: "not-a-date", activeSessionIds: [] }), false);
  assert.equal(validateBridgeHeartbeat({ protocolVersion: BRIDGE_PROTOCOL_VERSION, bridgeInstanceId: "bridge-1", sequence: 1, sentAt: "2026-08-01T00:00:00.000Z", activeSessionIds: Array.from({ length: 9 }, (_, index) => `session-${index}`) }), false);
});
