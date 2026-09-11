/**
 * ClaudeCodeProviderAdapter — Phase 3C tests
 *
 * Verifies the adapter genuinely wraps `buildClaudeCodeLaunchSpec`/
 * `parseClaudeCodeResult` (resident-provider-adapters.ts) rather than
 * reimplementing them, declares only capabilities those functions actually
 * support, allowlists environment variables (inherited from
 * `buildClaudeCodeLaunchSpec`'s own internal allowlist, not a second one),
 * normalizes Claude Code's real stream-json shapes deterministically without
 * fabricating a session-started marker or inferring tool activity, and
 * redacts Claude/Anthropic-shaped credentials before they reach a normalized
 * event or result.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ClaudeCodeProviderAdapter } from "../src/lib/mission/mission-provider-adapter-claude-code.ts";
import type { HostOutputEvent } from "../src/lib/mission/mission-process-host.ts";
import type { ProviderProcessSpec } from "../src/lib/resident-provider-adapters.ts";

function outputEvent(sequence: number, text: string): HostOutputEvent {
  return { sequence, emittedAt: "2026-07-30T00:00:00.000Z", raw: { kind: "output", stream: "stdout", text } };
}

test("discoverCapabilities declares only what buildClaudeCodeLaunchSpec/parseClaudeCodeResult actually support", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const capabilities = await adapter.discoverCapabilities({ workspaceId: "ws-1" });
  assert.equal(capabilities.non_interactive_execution, true);
  assert.equal(capabilities.structured_output, true);
  assert.equal(capabilities.streaming_output, true);
  assert.equal(capabilities.usage_reporting, true);
  assert.equal(capabilities.repository_editing, true);
  // Not fabricated — --no-session-persistence/--safe-mode explicitly rule these out:
  assert.equal(capabilities.interactive_session, false);
  assert.equal(capabilities.session_resume, false);
  assert.equal(capabilities.tool_event_reporting, false);
  assert.equal(capabilities.approval_requests, false);
  assert.equal(capabilities.image_input, false);
  assert.equal(capabilities.cancellation, false);
});

test("prepareInvocation builds a real Claude Code CLI spec via buildClaudeCodeLaunchSpec", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const invocation = await adapter.prepareInvocation(
    { missionId: "m-1", dispatchKey: "primary", goal: "fix the bug", executionConstraints: { executionMode: "workspace_write" } },
    { workingDirectory: "/tmp/worktree-1", kind: "disposable" },
  );
  assert.equal(invocation.adapterId, "claude-code");
  const spec = invocation.payload as ProviderProcessSpec;
  assert.equal(spec.cwd.replaceAll("\\", "/").replace(/^[a-zA-Z]:/, ""), "/tmp/worktree-1");
  assert.ok(spec.args.includes("--output-format"));
  assert.ok(spec.args.includes("stream-json"));
  assert.ok(spec.args.includes("--permission-mode"));
  assert.ok(spec.args.includes("acceptEdits"), "workspace_write mode must map to acceptEdits, not dontAsk");
});

test("prepareInvocation is deterministic: the same assignment always produces the same spec", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const assignment = { missionId: "m-1", dispatchKey: "primary", goal: "fix the bug", executionConstraints: { executionMode: "read_only" as const } };
  const environment = { workingDirectory: "/tmp/worktree-1", kind: "disposable" as const };
  const first = await adapter.prepareInvocation(assignment, environment);
  const second = await adapter.prepareInvocation(assignment, environment);
  assert.deepEqual(first, second);
});

test("prepareInvocation's spec.env is allowlisted — no arbitrary process.env keys leak through", async () => {
  const previous = process.env.SOME_UNRELATED_SECRET;
  process.env.SOME_UNRELATED_SECRET = "should-never-appear";
  try {
    const adapter = new ClaudeCodeProviderAdapter();
    const invocation = await adapter.prepareInvocation(
      { missionId: "m-1", dispatchKey: "primary", goal: "task", executionConstraints: {} },
      { workingDirectory: "/tmp/worktree-1", kind: "disposable" },
    );
    const spec = invocation.payload as ProviderProcessSpec;
    assert.equal(spec.env.SOME_UNRELATED_SECRET, undefined, "only the curated allowlist (PATH/HOME/ANTHROPIC_*/...) may be forwarded");
  } finally {
    if (previous === undefined) delete process.env.SOME_UNRELATED_SECRET;
    else process.env.SOME_UNRELATED_SECRET = previous;
  }
});

test("parseEvent never emits provider.session_started — no reliable one-shot marker exists in the reused parser", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const line = JSON.stringify({ type: "assistant", session_id: "session-abc", message: "hello" }) + "\n";
  const events = adapter.parseEvent(outputEvent(1, line));
  assert.ok(events.every((e) => e.type !== "provider.session_started"));
});

test("parseEvent preserves the session reference on progress events when the line exposes one", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const line = JSON.stringify({ type: "assistant", session_id: "session-abc" }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(1, line));
  assert.equal(event.type, "provider.progress");
  assert.equal(event.providerSessionRef, "session-abc");
});

test("parseEvent normalizes a terminal result line to provider.completed, REDACTED, when is_error is false", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const secretText = "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
  const line = JSON.stringify({ type: "result", session_id: "session-xyz", result: secretText, is_error: false }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(2, line));
  assert.equal(event.type, "provider.completed");
  assert.equal(event.redactionStatus, "redacted");
  assert.equal(event.providerSessionRef, "session-xyz");
  if (event.payload.type === "provider.completed") {
    assert.ok(!event.payload.summary.includes("sk-ant-api03-"), "raw secret must not survive into the normalized event");
  }
});

test("parseEvent normalizes a terminal result line to provider.failed when is_error is true", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const line = JSON.stringify({ type: "result", is_error: true, result: "permission denied" }) + "\n";
  const [event] = adapter.parseEvent(outputEvent(3, line));
  assert.equal(event.type, "provider.failed");
  if (event.payload.type === "provider.failed") assert.equal(event.payload.reason, "permission denied");
});

test("parseEvent does not infer a tool call from natural-language output", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const line = JSON.stringify({ type: "assistant", message: "I will now run the tests using the test runner tool." }) + "\n";
  const events = adapter.parseEvent(outputEvent(1, line));
  assert.ok(events.every((e) => e.type !== "provider.tool_requested" && e.type !== "provider.tool_completed"));
});

test("parseEvent maps explicitly structured Claude tool blocks to live activity", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const line = JSON.stringify({
    type: "assistant",
    session_id: "session-activity",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "src/lib/mission/mission-runtime.ts" } },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      ],
    },
  }) + "\n";
  const events = adapter.parseEvent(outputEvent(4, line));
  assert.deepEqual(events.map((event) => event.type), ["provider.activity", "provider.activity"]);
  if (events[0].payload.type === "provider.activity") {
    assert.equal(events[0].payload.activityKind, "file.read");
    assert.equal(events[0].payload.filePath, "src/lib/mission/mission-runtime.ts");
    assert.equal(events[0].providerSessionRef, "session-activity");
  }
  if (events[1].payload.type === "provider.activity") {
    assert.equal(events[1].payload.activityKind, "command.started");
    assert.equal(events[1].payload.command, "npm test");
  }
});

test("parseEvent is deterministic: the same raw line always normalizes the same way", () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const line = JSON.stringify({ type: "result", session_id: "s-1", result: "done", is_error: false }) + "\n";
  const first = adapter.parseEvent(outputEvent(1, line));
  const second = adapter.parseEvent(outputEvent(1, line));
  assert.deepEqual(first, second);
});

test("collectResult wraps parseClaudeCodeResult and redacts the summary before returning it", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const secretText = "here is a Bearer token: Bearer abcdefghijklmnopqrstuvwxyz012345";
  const raw = JSON.stringify({ type: "result", session_id: "s-1", result: secretText, is_error: false }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 0 });

  assert.equal(result.success, true);
  assert.equal(result.redactionStatus, "redacted");
  assert.equal(result.providerSessionRef, "s-1");
  assert.ok(!result.summary.includes("abcdefghijklmnopqrstuvwxyz012345"), "raw secret must not survive into the collected result");
});

test("collectResult reports failure on a nonzero exit code even with a structured message", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const raw = JSON.stringify({ type: "result", result: "partial output", is_error: false }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 1 });
  assert.equal(result.success, false);
});

test("collectResult reports failure when Claude Code reports is_error, regardless of exit code", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const raw = JSON.stringify({ type: "result", result: "should not count as success", is_error: true }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 0 });
  assert.equal(result.success, false);
});

test("a successful exit alone is not treated as validated evidence — collectResult only reports success/summary, never an evidence/validation verdict", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const raw = JSON.stringify({ type: "result", result: "looks fine", is_error: false }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 0 });
  assert.ok(!("evidenceStatus" in result), "ProviderResult has no evidence/validation field for an adapter to fill in — that classification belongs to evidence-submission.ts, downstream, never here");
});

test("redaction removes an environment-variable-shaped secret value from a Claude result, not just literal key= assignments", async () => {
  const adapter = new ClaudeCodeProviderAdapter();
  const raw = JSON.stringify({ type: "result", result: "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST", is_error: false }) + "\n";
  const result = await adapter.collectResult({ events: [outputEvent(1, raw)], exitCode: 0 });
  assert.ok(!result.summary.includes("sk-ant-api03-"));
});

test("a persisted process handle for a Claude Code launch carries no secret material — PersistableProcessHandle's fields are all non-secret by type", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
  try {
    const { InMemoryMissionSchedulerStore } = await import("../src/lib/mission/mission-scheduler-store.ts");
    const { InMemoryProcessExecutionHost } = await import("../src/lib/mission/mission-process-host.ts");
    const { ProviderAdapterRegistry } = await import("../src/lib/mission/mission-provider-registry.ts");
    const { RealExecutionHost } = await import("../src/lib/mission/mission-real-execution-host.ts");
    const { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES } = await import("../src/lib/mission/mission-scheduler.ts");

    const store = new InMemoryMissionSchedulerStore(new Map([["m-1", { workspaceId: "ws-1", repositoryId: null }]]));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();
    registry.register(new ClaudeCodeProviderAdapter());

    const host = new RealExecutionHost({
      processHost,
      registry,
      schedulerStore: store,
      repositoryRef: "C:/repos/app",
      requiredCapabilities: ["non_interactive_execution"],
    });

    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: "claude-code", executionConstraints: { goal: "task" } }],
      holder: { kind: "agent", id: "agent-a" },
      now: "2026-07-30T00:00:00.000Z",
      policy: DEFAULT_SCHEDULER_POLICY,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    await host.start(claimed.claimed[0].instruction);

    const outstanding = await store.listOutstandingDispatchIntents("ws-1");
    const persistedHandle = JSON.stringify(outstanding[0]?.processHandle);
    assert.ok(!persistedHandle.includes("sk-ant-api03-"), "the persisted handle must never carry the real Anthropic API key value");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
