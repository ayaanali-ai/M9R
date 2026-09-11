import { test } from "node:test";
import assert from "node:assert/strict";
import type { BridgeRuntimeEventSinkInput } from "../src/lib/bridge/acp-client.ts";
import { evidenceCandidateFromRuntimeEvent, reportRuntimeEvidence } from "../src/lib/bridge/mission-evidence-reporter.ts";

function fakeSession(overrides: Partial<BridgeRuntimeEventSinkInput["session"]> = {}): BridgeRuntimeEventSinkInput["session"] {
  return {
    sessionId: "sess-1",
    bridgeInstanceId: "bridge-1",
    workspaceId: "ws-1",
    missionId: "m-1",
    participantId: "p-codex",
    providerAdapterId: "codex-acp",
    providerSessionRef: "ref-1",
    state: "working",
    capabilities: {},
    lastHeartbeatAt: null,
    unreadDeliveryCount: 0,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("a completed file change becomes diff_or_patch evidence", () => {
  const input: BridgeRuntimeEventSinkInput = {
    session: fakeSession(),
    executionId: "exec-1",
    assignmentId: "a-1",
    event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:01.000Z", payload: { activityKind: "file.changed", status: "completed", filePath: "src/foo.ts", summary: "Provider changed a file" } },
  };
  const candidate = evidenceCandidateFromRuntimeEvent(input);
  assert.deepEqual(candidate, {
    missionId: "m-1", participantId: "p-codex", executionId: "exec-1", assignmentId: "a-1",
    provider: "codex-acp", kind: "diff_or_patch", source: "Edited src/foo.ts",
  });
});

test("a completed command becomes test_result evidence", () => {
  const input: BridgeRuntimeEventSinkInput = {
    session: fakeSession(),
    executionId: "exec-2",
    assignmentId: null,
    event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:02.000Z", payload: { activityKind: "command.completed", status: "completed", command: "npm test" } },
  };
  const candidate = evidenceCandidateFromRuntimeEvent(input);
  assert.equal(candidate?.kind, "test_result");
  assert.equal(candidate?.source, "Ran: npm test");
  assert.equal(candidate?.assignmentId, null);
});

test("a started event (not yet completed) is never evidence", () => {
  const input: BridgeRuntimeEventSinkInput = {
    session: fakeSession(),
    executionId: "exec-3",
    assignmentId: null,
    event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:03.000Z", payload: { activityKind: "command.started", status: "started", command: "npm test" } },
  };
  assert.equal(evidenceCandidateFromRuntimeEvent(input), null);
});

test("a file read (not a change) is never evidence", () => {
  const input: BridgeRuntimeEventSinkInput = {
    session: fakeSession(),
    executionId: "exec-4",
    assignmentId: null,
    event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:04.000Z", payload: { activityKind: "file.read", status: "completed", filePath: "src/foo.ts" } },
  };
  assert.equal(evidenceCandidateFromRuntimeEvent(input), null);
});

test("a non-activity event type (e.g. usage update) is never evidence", () => {
  const input: BridgeRuntimeEventSinkInput = {
    session: fakeSession(),
    executionId: "exec-5",
    assignmentId: null,
    event: { type: "provider.usage_updated", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:05.000Z", payload: { inputTokens: 10, outputTokens: 5 } },
  };
  assert.equal(evidenceCandidateFromRuntimeEvent(input), null);
});

test("reportRuntimeEvidence POSTs the mapped candidate to the right Mission and never throws on failure", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  let capturedAuth: string | null = null;
  let capturedBody: unknown = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ evidence: { id: "e-1" } }), { status: 201 });
  }) as typeof fetch;

  try {
    const input: BridgeRuntimeEventSinkInput = {
      session: fakeSession(),
      executionId: "exec-6",
      assignmentId: "a-2",
      event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:06.000Z", payload: { activityKind: "file.changed", status: "completed", filePath: "src/bar.ts" } },
    };
    await reportRuntimeEvidence({ appUrl: "https://oathlock.example/", agentToken: "tok-123", event: input });

    assert.equal(capturedUrl, "https://oathlock.example/api/missions/m-1/evidence");
    const authHeader = capturedAuth as string | null;
    assert.equal(authHeader, "Bearer tok-123");
    assert.deepEqual(capturedBody, {
      assignmentId: "a-2", producerParticipantId: "p-codex", producerKind: "agent",
      executionId: "exec-6", provider: "codex-acp", kind: "diff_or_patch",
      source: "Edited src/bar.ts", lifecycle: "captured", availability: "available",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reportRuntimeEvidence does not call fetch at all for a non-evidence event", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    const input: BridgeRuntimeEventSinkInput = {
      session: fakeSession(),
      executionId: "exec-7",
      assignmentId: null,
      event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:07.000Z", payload: { activityKind: "command.started", status: "started" } },
    };
    await reportRuntimeEvidence({ appUrl: "https://oathlock.example", agentToken: "tok-123", event: input });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reportRuntimeEvidence swallows a failed request instead of throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("server error", { status: 500 })) as typeof fetch;
  try {
    const input: BridgeRuntimeEventSinkInput = {
      session: fakeSession(),
      executionId: "exec-8",
      assignmentId: null,
      event: { type: "provider.activity", sessionId: "sess-1", occurredAt: "2026-08-04T00:00:08.000Z", payload: { activityKind: "file.changed", status: "completed", filePath: "x.ts" } },
    };
    await assert.doesNotReject(() => reportRuntimeEvidence({ appUrl: "https://oathlock.example", agentToken: "tok-123", event: input }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
