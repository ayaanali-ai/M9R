import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { AcpStdioProviderAdapter } from "@/lib/bridge/acp-stdio-adapter";

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/hanging-acp-agent.mjs");

/**
 * End-to-end against a real spawned process, not a mock: a fixture ACP
 * agent (scripts/fixtures/hanging-acp-agent.mjs) that answers the
 * handshake normally but never responds to session/prompt, reproducing the
 * exact "provider never replies" condition observed live (matching
 * CreateProcessAsUserW failures) that used to hang bridge-runtime.ts's
 * turn loop forever and permanently lock that agent's session.
 */
test("prompt() times out instead of hanging forever when the provider never responds, and cleans up so a later prompt can still be issued", async () => {
  const adapter = new AcpStdioProviderAdapter({
    id: "hanging-fixture",
    command: process.execPath,
    args: [FIXTURE_PATH],
    promptTimeoutMs: 500,
  });

  const server = await adapter.launchServer({
    assignment: { missionId: "test-mission", dispatchKey: "test-dispatch", goal: "test", executionConstraints: {} },
    environment: { workingDirectory: resolve(import.meta.dirname, ".."), kind: "disposable" },
  });

  try {
    await adapter.initialize(server);
    const session = await adapter.createSession({
      server,
      assignment: { missionId: "test-mission", dispatchKey: "test-dispatch", goal: "test", executionConstraints: {} },
    });

    const startedAt = Date.now();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for await (const event of adapter.prompt({ session, text: "do the thing" })) {
      events.push({ type: event.type, payload: event.payload });
    }
    const elapsedMs = Date.now() - startedAt;

    // The core bug: with no timeout, this loop -- and this whole test --
    // would simply never finish. Reaching this line at all is the fix
    // working; the elapsed-time bound confirms it's the timeout that fired,
    // not some other coincidental resolution.
    assert.ok(elapsedMs < 5_000, `expected the 500ms timeout to fire well under 5s, took ${elapsedMs}ms`);
    assert.ok(elapsedMs >= 500, `timeout must not fire before its own deadline, fired at ${elapsedMs}ms`);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "provider.failed");
    assert.match(String(events[0].payload.reason), /did not respond within 500ms/);

    // The actual production bug: acp-client.ts's `session.queue` guard
    // throws "ACP session already has an active prompt" for any prompt()
    // call issued while a prior one is still considered in-flight. If the
    // timeout path failed to clear session.queue, THIS call would throw
    // immediately instead of running a second real (if also-hung) turn --
    // that's what would leave bridge-runtime.ts's sessionBusy flag stuck
    // forever in production. Reaching a second timeout, not an
    // "already has an active prompt" error, is the actual proof of recovery.
    const secondEvents: Array<{ type: string }> = [];
    for await (const event of adapter.prompt({ session, text: "do the thing again" })) {
      secondEvents.push({ type: event.type });
    }
    assert.equal(secondEvents.length, 1);
    assert.equal(secondEvents[0].type, "provider.failed");
  } finally {
    await adapter.shutdown(server);
  }
});
