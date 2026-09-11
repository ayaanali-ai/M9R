import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkgraph, type WorkgraphInput } from "../src/lib/workgraph.ts";
import type { WireEntry } from "../src/lib/dispatch-service.ts";
import type { ResponseEntry } from "../src/lib/response-service.ts";
import type { FindingView } from "../src/lib/finding-service.ts";

function baseInput(overrides: Partial<WorkgraphInput> = {}): WorkgraphInput {
  return {
    runId: "run-1",
    runLabel: "Fix live sync",
    dispatches: [],
    responses: [],
    publishedFindings: [],
    adoptedFindings: [],
    humanReviewDecision: null,
    linkedRunIds: [],
    ...overrides,
  };
}

test("a bare run with no activity produces exactly one node and no edges", () => {
  const graph = buildWorkgraph(baseInput());
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].type, "run");
  assert.deepEqual(graph.edges, []);
});

test("dispatches become nodes published by the run", () => {
  const dispatches: WireEntry[] = [
    { id: "d1", runId: "run-1", type: "RUN_STARTED", sender: "codex", summary: "run started", detail: null, scope: [], resolutionState: "open", createdAt: "2026-07-11T10:00:00Z" },
  ];
  const graph = buildWorkgraph(baseInput({ dispatches }));
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, [{ from: "run-1", to: "d1", relation: "published" }]);
});

test("a response answering a dispatch gets an 'answers' edge, not 'published'", () => {
  const dispatches: WireEntry[] = [
    { id: "d1", runId: "run-1", type: "HUMAN_DECISION_REQUIRED", sender: "codex", summary: "need decision", detail: null, scope: [], resolutionState: "open", createdAt: "2026-07-11T10:00:00Z" },
  ];
  const responses: ResponseEntry[] = [
    { id: "r1", runId: "run-1", dispatchId: "d1", type: "clarification", senderRole: "operator", sender: "operator", recipient: "codex", body: "go ahead", scope: [], resolutionState: "resolved", createdAt: "2026-07-11T10:01:00Z" },
  ];
  const graph = buildWorkgraph(baseInput({ dispatches, responses }));
  assert.ok(graph.edges.some((e) => e.from === "r1" && e.to === "d1" && e.relation === "answers"));
});

function finding(overrides: Partial<FindingView> = {}): FindingView {
  return {
    id: "f1",
    originatingRunId: "run-1",
    originatingSender: "codex",
    title: "A finding",
    applicableEnvironment: "env",
    observedBehavior: "behavior",
    evidenceLevel: "correlated",
    suggestedResponse: "response",
    knownLimitations: [],
    reviewState: "available",
    createdAt: "2026-07-11T10:00:00Z",
    ...overrides,
  };
}

test("published findings get 'originated', adopted findings get 'adopted'", () => {
  const graph = buildWorkgraph(
    baseInput({
      publishedFindings: [finding({ id: "f-own" })],
      adoptedFindings: [finding({ id: "f-other", originatingRunId: "run-0" })],
    }),
  );
  assert.ok(graph.edges.some((e) => e.to === "f-own" && e.relation === "originated"));
  assert.ok(graph.edges.some((e) => e.to === "f-other" && e.relation === "adopted"));
});

test("a human review decision becomes its own node with a 'reviewed_as' edge", () => {
  const graph = buildWorkgraph(baseInput({ humanReviewDecision: "reviewed" }));
  const decisionNode = graph.nodes.find((n) => n.type === "decision");
  assert.ok(decisionNode);
  assert.equal(decisionNode!.label, "reviewed");
  assert.ok(graph.edges.some((e) => e.relation === "reviewed_as" && e.to === decisionNode!.id));
});

test("a linked run points 'supports' back at the parent run", () => {
  const graph = buildWorkgraph(baseInput({ linkedRunIds: ["linked-1"] }));
  assert.ok(graph.edges.some((e) => e.from === "linked-1" && e.to === "run-1" && e.relation === "supports"));
});

test("a returned provider result is linked to the explicit primary-agent decision", () => {
  const graph = buildWorkgraph(baseInput({ resultAdoptions: [{
    id: "adoption-1", launchGrantId: "grant-1", decision: "adopted", planEffect: "Add the missing flag.",
  }] }));
  assert.ok(graph.edges.some((edge) => edge.from === "grant:grant-1" && edge.to === "adoption-1" && edge.relation === "considered"));
  assert.ok(graph.edges.some((edge) => edge.from === "adoption-1" && edge.to === "run-1" && edge.relation === "changed_plan"));
});

test("no edge is fabricated: every edge endpoint corresponds to a real node id", () => {
  const graph = buildWorkgraph(
    baseInput({
      dispatches: [{ id: "d1", runId: "run-1", type: "WORKING", sender: "codex", summary: "working", detail: null, scope: [], resolutionState: "open", createdAt: "2026-07-11T10:00:00Z" }],
      publishedFindings: [finding()],
      linkedRunIds: ["linked-1"],
    }),
  );
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.from), `missing node for edge.from: ${edge.from}`);
    assert.ok(nodeIds.has(edge.to), `missing node for edge.to: ${edge.to}`);
  }
});
