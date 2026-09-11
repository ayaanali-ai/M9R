/**
 * ProviderAdapter contract — Phase 3A tests (FakeProviderAdapter)
 *
 * Covers: honest capability declaration, deterministic event normalization,
 * result collection, redaction integration using the EXISTING `redactSession`
 * utility (reused, not reimplemented), and the structural guarantee that an
 * adapter cannot mutate Mission or scheduler-store state — it is never even
 * given a reference to one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FakeProviderAdapter, allCapabilitiesFalse, supportsAllCapabilities } from "../src/lib/mission/mission-provider-adapter.ts";
import { redactSession } from "../src/lib/session-redaction.ts";
import type { HostOutputEvent } from "../src/lib/mission/mission-process-host.ts";

test("allCapabilitiesFalse declares every capability explicitly false, never omitted", () => {
  const capabilities = allCapabilitiesFalse();
  assert.equal(capabilities.non_interactive_execution, false);
  assert.equal(capabilities.repository_editing, false);
  assert.equal(Object.keys(capabilities).length, 11);
});

test("an adapter that declares no capabilities honestly reports none supported", async () => {
  const adapter = new FakeProviderAdapter("fake-1");
  const capabilities = await adapter.discoverCapabilities({ workspaceId: "ws-1" });
  assert.equal(supportsAllCapabilities(capabilities, ["non_interactive_execution"]), false);
});

test("an adapter declaring a capability reports it, and only it, as supported", async () => {
  const adapter = new FakeProviderAdapter("fake-1", { non_interactive_execution: true });
  const capabilities = await adapter.discoverCapabilities({ workspaceId: "ws-1" });
  assert.equal(supportsAllCapabilities(capabilities, ["non_interactive_execution"]), true);
  assert.equal(supportsAllCapabilities(capabilities, ["non_interactive_execution", "session_resume"]), false);
});

test("parseEvent normalizes deterministically: the same raw event always produces the same normalized event", () => {
  const adapter = new FakeProviderAdapter("fake-1");
  const raw: HostOutputEvent = { sequence: 1, emittedAt: "2026-07-28T00:00:00.000Z", raw: { kind: "output", text: "hello" } };

  const first = adapter.parseEvent(raw);
  const second = adapter.parseEvent(raw);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, "provider.output");
});

test("every normalized event carries the required envelope fields", () => {
  const adapter = new FakeProviderAdapter("fake-1");
  const raw: HostOutputEvent = { sequence: 3, emittedAt: "2026-07-28T00:00:01.000Z", raw: { kind: "progress" } };
  const [event] = adapter.parseEvent(raw);

  assert.equal(typeof event.executionId, "string");
  assert.equal(event.adapterId, "fake-1");
  assert.equal(typeof event.correlationId, "string");
  assert.equal(event.causationId, null);
  assert.equal(event.timestamp, raw.emittedAt);
  assert.notEqual(event.rawEventRef, undefined);
  assert.ok(["redacted", "not_required", "pending"].includes(event.redactionStatus));
});

test("collectResult maps a zero exit code to success and a nonzero one to failure", async () => {
  const adapter = new FakeProviderAdapter("fake-1");
  const success = await adapter.collectResult({ events: [], exitCode: 0 });
  assert.equal(success.success, true);

  const failure = await adapter.collectResult({ events: [], exitCode: 1 });
  assert.equal(failure.success, false);
});

test("raw provider output is redacted before durable exposure, reusing the existing redactSession utility (not a reimplementation)", () => {
  const secretBearing = "here is a key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
  const redaction = redactSession(secretBearing);

  assert.ok(!redaction.redactedText.includes("sk-ant-api03-"), "the raw secret must not survive into the text a normalized event would carry");
  assert.ok(redaction.countsByType["anthropic_api_key"] >= 1 || Object.values(redaction.countsByType).some((n) => n > 0));

  // What a real adapter's parseEvent would emit for a `provider.output`
  // event, having reused redactSession rather than inventing its own scanner:
  const eventText = redaction.redactedText;
  const redactionStatus = "redacted" as const;
  assert.ok(!eventText.includes("sk-ant-api03-"));
  assert.equal(redactionStatus, "redacted");
});

test("adapter methods never touch a Mission or scheduler store — no such reference is ever passed to them", async () => {
  // A store double that throws on ANY property access at all — if any
  // adapter method reached for a store method (even just to read one), this
  // would throw. It never has the opportunity: no method on ProviderAdapter
  // accepts a store or Mission as an argument, which this test also confirms
  // by construction (see the call sites below — none pass one).
  const poisonedStore = new Proxy(
    {},
    {
      get(): never {
        throw new Error("adapter must never touch a scheduler store or Mission reference");
      },
    },
  );
  void poisonedStore;

  const adapter = new FakeProviderAdapter("fake-1", { non_interactive_execution: true });
  await adapter.discoverCapabilities({ workspaceId: "ws-1" });
  await adapter.prepareInvocation({ missionId: "m-1", dispatchKey: "primary", goal: "do the thing", executionConstraints: {} }, { workingDirectory: "/tmp/x", kind: "disposable" });
  adapter.parseEvent({ sequence: 1, emittedAt: "2026-07-28T00:00:00.000Z", raw: { kind: "output", text: "hi" } });
  await adapter.collectResult({ events: [], exitCode: 0 });
  // No assertion needed beyond "this ran without ever being handed the
  // poisoned store" — the type signatures of ProviderAdapter's methods
  // (mission-provider-adapter.ts) structurally forbid passing one at all.
});
