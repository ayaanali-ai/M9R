/**
 * CodexProviderAdapter — Phase 3B tests
 *
 * Verifies the adapter genuinely wraps `buildCodexLaunchSpec`/
 * `parseCodexResult` (resident-provider-adapters.ts) rather than
 * reimplementing them, honestly declares only the capabilities those
 * functions actually support, normalizes Codex's real stream-json shapes
 * deterministically, and redacts before any text reaches a normalized event
 * or result.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CodexProviderAdapter } from "../src/lib/mission/mission-provider-adapter-codex.ts";
import type { HostOutputEvent } from "../src/lib/mission/mission-process-host.ts";
import type { ProviderProcessSpec } from "../src/lib/resident-provider-adapters.ts";

function outputEvent(sequence: number, text: string): HostOutputEvent {
  return { sequence, emittedAt: "2026-07-29T00:00:00.000Z", raw: { kind: "output", stream: "stdout", text } };
}

test("discoverCapabilities declares only what buildCodexLaunchSpec/parseCodexResult actually support", async () => {
  const adapter = new CodexProviderAdapter();
  const capabilities = await adapter.discoverCapabilities({ workspaceId: "ws-1" });
  assert.equal(capabilities.non_interactive_execution, true);
  assert.equal(capabilities.structured_output, true);
  assert.equal(capabilities.usage_reporting, true);
  assert.equal(capabilities.repository_editing, true);
  // Not fabricated:
  assert.equal(capabilities.interactive_session, false);
  assert.equal(capabilities.session_resume, false);
  assert.equal(capabilities.image_input, false);
  assert.equal(capabilities.approval_requests, false);
});

test("prepareInvocation builds a real Codex CLI spec via buildCodexLaunchSpec", async () => {
  const adapter = new CodexProviderAdapter();
  const invocation = await adapter.prepareInvocation(
    { missionId: "m-1", dispatchKey: "primary", goal: "fix the bug", executionConstraints: { executionMode: "read_only" } },
    { workingDirectory: "/tmp/worktree-1", kind: "disposable" },
  );
  assert.equal(invocation.adapterId, "codex");
  const spec = invocation.payload as ProviderProcessSpec;
  assert.equal(spec.cwd.replaceAll("\\", "/").replace(/^[a-zA-Z]:/, ""), "/tmp/worktree-1");
  assert.ok(spec.args.includes("exec"));
  assert.ok(spec.args.includes("--sandbox"));
  assert.ok(spec.args.includes("read-only"));
});

test("parseEvent normalizes a thread.started line to provider.session_started, carrying the session ref", () => {
  const adapter = new CodexProviderAdapter();
  const line = JSON.stringify({ type: "thread.started", thread_id: "thread-abc" }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(1, line));
  assert.equal(event.type, "provider.session_started");
  assert.equal(event.providerSessionRef, "thread-abc");
});

test("parseEvent normalizes a completed agent_message line to provider.output, REDACTED", () => {
  const adapter = new CodexProviderAdapter();
  const secretText = "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
  const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: secretText } }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(2, line));
  assert.equal(event.type, "provider.output");
  assert.equal(event.redactionStatus, "redacted");
  if (event.payload.type === "provider.output") {
    assert.ok(!event.payload.text.includes("sk-ant-api03-"), "raw secret must not survive into the normalized event");
  }
});

test("parseEvent emits structured file-change and command/test activity", () => {
  const adapter = new CodexProviderAdapter();
  const line = [
    JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/lib/auth.ts", kind: "update" }] } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 0, test_name: "mission suite", test_passed: 12, test_failed: 0 } }),
  ].join("\n") + "\n";
  const events = adapter.parseEvent(outputEvent(4, line));
  assert.deepEqual(events.map((event) => event.type), ["provider.activity", "provider.activity"]);
  assert.equal(events[0].payload.type, "provider.activity");
  if (events[0].payload.type === "provider.activity") {
    assert.equal(events[0].payload.activityKind, "file.changed");
    assert.equal(events[0].payload.filePath, "src/lib/auth.ts");
  }
  if (events[1].payload.type === "provider.activity") {
    assert.equal(events[1].payload.activityKind, "test.completed");
    assert.equal(events[1].payload.testPassed, 12);
  }
});

test("parseEvent does not classify an unlabelled command as a test", () => {
  const adapter = new CodexProviderAdapter();
  const line = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "node script.js", exit_code: 0 } }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(5, line));
  assert.equal(event.type, "provider.activity");
  if (event.payload.type === "provider.activity") assert.equal(event.payload.activityKind, "command.completed");
});

test("parseEvent normalizes a turn.failed line to provider.failed", () => {
  const adapter = new CodexProviderAdapter();
  const line = JSON.stringify({ type: "turn.failed", message: "sandbox denied a syscall" }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(3, line));
  assert.equal(event.type, "provider.failed");
  if (event.payload.type === "provider.failed") assert.equal(event.payload.reason, "sandbox denied a syscall");
});

test("parseEvent is deterministic: the same raw line always normalizes the same way", () => {
  const adapter = new CodexProviderAdapter();
  const line = JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\n";
  const first = adapter.parseEvent(outputEvent(1, line));
  const second = adapter.parseEvent(outputEvent(1, line));
  assert.deepEqual(first, second);
});

test("collectResult wraps parseCodexResult and redacts the summary before returning it", async () => {
  const adapter = new CodexProviderAdapter();
  const secretText = "here is a Bearer token: Bearer abcdefghijklmnopqrstuvwxyz012345";
  const raw = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: secretText } }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 0 });

  assert.equal(result.success, true);
  assert.equal(result.redactionStatus, "redacted");
  assert.ok(!result.summary.includes("abcdefghijklmnopqrstuvwxyz012345"), "raw secret must not survive into the collected result");
});

test("collectResult reports failure when Codex exits nonzero, even with a structured message", async () => {
  const adapter = new CodexProviderAdapter();
  const raw = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial output" } }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 1 });
  assert.equal(result.success, false);
});

test("collectResult reports failure when Codex reports an error, regardless of exit code", async () => {
  const adapter = new CodexProviderAdapter();
  const raw = JSON.stringify({ type: "error" }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 0 });
  assert.equal(result.success, false);
});
