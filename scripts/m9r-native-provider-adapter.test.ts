import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// See m9r-native-agent-loop.test.ts's own comment -- the register-alias.mjs
// test loader doesn't source .env.local, and the credential-gating path
// below needs a real Supabase connection to prove "no credential stored"
// rather than "backend not configured".
try {
  const envText = readFileSync(".env.local", "utf8");
  for (const line of envText.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {
  // No .env.local in this environment.
}

test("M9rNativeProviderAdapter declares honest capabilities -- only what phases 1/2 actually built", async () => {
  const { createM9rNativeAdapter } = await import("../src/lib/bridge/m9r-native-provider-adapter");
  const adapter = createM9rNativeAdapter({ workspaceId: "00000000-0000-0000-0000-000000000099" });
  const caps = await adapter.discoverCapabilities({ workspaceId: "00000000-0000-0000-0000-000000000099" });
  assert.equal(caps.streaming_output, true);
  assert.equal(caps.tool_event_reporting, true);
  assert.equal(caps.repository_editing, true);
  assert.equal(caps.cancellation, true);
  // Named gaps -- must stay false until the corresponding phase actually ships.
  assert.equal(caps.session_resume, false);
  assert.equal(caps.approval_requests, false);
  assert.equal(caps.image_input, false);
});

test("full lifecycle without a real model call: launch, initialize, create, close, shutdown", async () => {
  const { createM9rNativeAdapter } = await import("../src/lib/bridge/m9r-native-provider-adapter");
  const adapter = createM9rNativeAdapter({ workspaceId: "00000000-0000-0000-0000-000000000099" });
  const server = await adapter.launchServer({
    assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} },
    environment: { workingDirectory: process.cwd(), kind: "disposable" },
  });
  assert.equal(server.adapterId, "m9r-native");
  assert.equal(adapter.getServerHealth(server).state, "alive");

  const initialized = await adapter.initialize(server);
  assert.equal(initialized.agentName, "M9R");

  const session = await adapter.createSession({ server, assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} } });
  assert.ok(session.sessionId.startsWith("m9r-native-session-"));
  assert.equal(session.availableModels, null);

  await adapter.closeSession({ session });
  await adapter.shutdown(server);
});

test("resumeSession and respondToPermission fail with a named, honest error rather than silently no-opping", async () => {
  const { createM9rNativeAdapter } = await import("../src/lib/bridge/m9r-native-provider-adapter");
  const adapter = createM9rNativeAdapter({ workspaceId: "00000000-0000-0000-0000-000000000099" });
  const server = await adapter.launchServer({
    assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} },
    environment: { workingDirectory: process.cwd(), kind: "disposable" },
  });
  await assert.rejects(
    () => adapter.resumeSession({ server, providerSessionRef: "whatever", assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} } }),
    /does not support resuming a session yet/,
  );

  const session = await adapter.createSession({ server, assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} } });
  await assert.rejects(
    () => adapter.respondToPermission({ session, requestId: "r1", approved: true }),
    /does not raise permission requests yet/,
  );
});

test("prompt() surfaces the missing-credential case as a real provider.failed event, not an uncaught throw", async () => {
  const { createM9rNativeAdapter } = await import("../src/lib/bridge/m9r-native-provider-adapter");
  const adapter = createM9rNativeAdapter({ workspaceId: "00000000-0000-0000-0000-000000000099" }); // no credential stored for this workspace
  const server = await adapter.launchServer({
    assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} },
    environment: { workingDirectory: process.cwd(), kind: "disposable" },
  });
  const session = await adapter.createSession({ server, assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} } });

  const events = [];
  for await (const event of adapter.prompt({ session, text: "irrelevant" })) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "provider.failed");
  assert.match((events[0].payload as { reason: string }).reason, /No Anthropic credential is stored/);
});

test("cancelTurn on a session with no active prompt does not throw", async () => {
  const { createM9rNativeAdapter } = await import("../src/lib/bridge/m9r-native-provider-adapter");
  const adapter = createM9rNativeAdapter({ workspaceId: "00000000-0000-0000-0000-000000000099" });
  const server = await adapter.launchServer({
    assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} },
    environment: { workingDirectory: process.cwd(), kind: "disposable" },
  });
  const session = await adapter.createSession({ server, assignment: { missionId: "channel-test", dispatchKey: "k", goal: "g", executionConstraints: {} } });
  await assert.doesNotReject(() => adapter.cancelTurn({ session }));
});
