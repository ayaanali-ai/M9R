import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateResponse,
  isResponseType,
  resolvesDispatch,
  RESPONSE_TYPES,
  RESPONSE_SCHEMA_VERSION,
  type ResponseInput,
} from "../src/lib/response.ts";
import { buildRunThread } from "../src/lib/run-thread.ts";
import type { WireEntry } from "../src/lib/dispatch-service.ts";
import type { ResponseEntry } from "../src/lib/response-service.ts";

function baseInput(overrides: Partial<ResponseInput> = {}): ResponseInput {
  return {
    workspaceId: "ws-1",
    runId: "run-1",
    dispatchId: "dispatch-1",
    type: "clarification",
    senderRole: "operator",
    sender: "operator",
    recipient: "codex",
    body: "Use the existing evidence-contract.ts pattern.",
    ...overrides,
  };
}

test("all nine response types are recognized", () => {
  assert.deepEqual(
    [...RESPONSE_TYPES],
    ["acknowledgement", "clarification", "finding", "artifact", "scope_decision", "acceptance", "dispute", "human_instruction", "resolution"],
  );
  assert.ok(isResponseType("dispute"));
  assert.ok(!isResponseType("nonsense"));
});

test("resolving types close the parent dispatch; others leave it open", () => {
  assert.ok(resolvesDispatch("acceptance"));
  assert.ok(resolvesDispatch("dispute"));
  assert.ok(resolvesDispatch("resolution"));
  assert.ok(resolvesDispatch("scope_decision"));
  assert.ok(!resolvesDispatch("clarification"));
  assert.ok(!resolvesDispatch("acknowledgement"));
});

test("a valid response normalizes with the correct resolution state", () => {
  const open = validateResponse(baseInput({ type: "clarification" }));
  assert.equal(open.ok, true);
  assert.equal(open.normalized!.resolutionState, "open");
  assert.equal(open.normalized!.schemaVersion, RESPONSE_SCHEMA_VERSION);

  const resolved = validateResponse(baseInput({ type: "acceptance" }));
  assert.equal(resolved.normalized!.resolutionState, "resolved");
});

test("a response can stand alone with no dispatchId", () => {
  const result = validateResponse(baseInput({ dispatchId: null }));
  assert.equal(result.ok, true);
  assert.equal(result.normalized!.dispatchId, null);
});

test("rejects an unknown response type", () => {
  const result = validateResponse(baseInput({ type: "chit_chat" as never }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "type"));
});

test("rejects an empty body", () => {
  const result = validateResponse(baseInput({ body: "   " }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "body"));
});

test("rejects secret-shaped content in the body", () => {
  const result = validateResponse(baseInput({ body: "Bearer sk-live-abcdef1234567890" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Rejected/.test(e.message)));
});

test("Run Thread merges dispatches and responses in chronological order", () => {
  const dispatches: WireEntry[] = [
    { id: "d1", runId: "run-1", type: "RUN_STARTED", sender: "codex", summary: "run started", detail: null, scope: [], resolutionState: "open", createdAt: "2026-07-11T10:00:00Z" },
    { id: "d2", runId: "run-1", type: "HUMAN_DECISION_REQUIRED", sender: "codex", summary: "need a decision", detail: null, scope: [], resolutionState: "open", createdAt: "2026-07-11T10:05:00Z" },
  ];
  const responses: ResponseEntry[] = [
    { id: "r1", runId: "run-1", dispatchId: "d2", type: "clarification", senderRole: "operator", sender: "operator", recipient: "codex", body: "go ahead", scope: [], resolutionState: "resolved", createdAt: "2026-07-11T10:03:00Z" },
  ];
  const thread = buildRunThread(dispatches, responses);
  assert.deepEqual(thread.map((t) => t.id), ["d1", "r1", "d2"]);
  assert.equal(thread[1].kind, "response");
  assert.equal(thread[1].respondsToDispatchId, "d2");
});

test("Run Thread carries canonical agent identity independently of sender text", () => {
  const dispatches: WireEntry[] = [
    {
      id: "d-grok",
      runId: "run-grok",
      type: "HELP_REQUESTED",
      sender: "Claude mentioned this in a pasted note",
      summary: "request a bounded review",
      detail: null,
      scope: [],
      resolutionState: "open",
      createdAt: "2026-07-11T10:00:00Z",
    },
  ];
  const responses: ResponseEntry[] = [
    {
      id: "r-grok",
      runId: "run-grok",
      dispatchId: "d-grok",
      type: "finding",
      senderRole: "agent",
      sender: "a free-text status that also says Codex",
      recipient: "operator",
      body: "review returned",
      scope: [],
      resolutionState: "resolved",
      createdAt: "2026-07-11T10:01:00Z",
    },
  ];

  const thread = buildRunThread(dispatches, responses, { sourceAgentKind: "grok-build" });
  assert.deepEqual(thread.map((entry) => entry.senderAgentKind), ["grok-build", "grok-build"]);
});
