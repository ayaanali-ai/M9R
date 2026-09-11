/**
 * Workgraph — OathLock V2 Phase 9
 * ----------------------------------------------------------------------------
 * The durable relationship map connecting a Run to everything that happened
 * around it: its Dispatches, Responses, published Findings, Findings it
 * adopted, its human review decision, and any Linked (supporting) Run.
 *
 * Pure/IO-free: callers fetch the pieces (dispatch-service, response-service,
 * finding-service) and pass them in. This shows how work moved through the
 * network — it does not compute or infer new relationships, only renders the
 * ones that are already stored as real rows. No edge here is fabricated.
 */

import type { WireEntry } from "./dispatch-service";
import type { ResponseEntry } from "./response-service";
import type { FindingView } from "./finding-service";

export type WorkgraphNodeType = "run" | "dispatch" | "response" | "finding" | "decision" | "linked_run" | "provider_result" | "adoption";

export interface WorkgraphNode {
  id: string;
  type: WorkgraphNodeType;
  label: string;
}

export type WorkgraphEdgeRelation =
  | "published"
  | "answers"
  | "originated"
  | "adopted"
  | "reviewed_as"
  | "supports"
  | "returned"
  | "considered"
  | "changed_plan";

export interface WorkgraphEdge {
  from: string;
  to: string;
  relation: WorkgraphEdgeRelation;
}

export interface Workgraph {
  nodes: WorkgraphNode[];
  edges: WorkgraphEdge[];
}

export interface WorkgraphInput {
  runId: string;
  runLabel: string;
  dispatches: WireEntry[];
  responses: ResponseEntry[];
  /** Findings this run published (originatingRunId === runId). */
  publishedFindings: FindingView[];
  /** Findings this run adopted from earlier reviewed runs. */
  adoptedFindings: FindingView[];
  humanReviewDecision: string | null;
  linkedRunIds: string[];
  resultAdoptions?: Array<{ id: string; launchGrantId: string; decision: string; planEffect: string }>;
}

export function buildWorkgraph(input: WorkgraphInput): Workgraph {
  const nodes: WorkgraphNode[] = [{ id: input.runId, type: "run", label: input.runLabel }];
  const edges: WorkgraphEdge[] = [];

  for (const d of input.dispatches) {
    nodes.push({ id: d.id, type: "dispatch", label: `${d.type}: ${d.summary}` });
    edges.push({ from: input.runId, to: d.id, relation: "published" });
  }

  for (const r of input.responses) {
    nodes.push({ id: r.id, type: "response", label: `${r.type}: ${r.body}` });
    if (r.dispatchId) {
      edges.push({ from: r.id, to: r.dispatchId, relation: "answers" });
    } else {
      edges.push({ from: input.runId, to: r.id, relation: "published" });
    }
  }

  for (const f of input.publishedFindings) {
    nodes.push({ id: f.id, type: "finding", label: f.title });
    edges.push({ from: input.runId, to: f.id, relation: "originated" });
  }

  for (const f of input.adoptedFindings) {
    if (!nodes.some((n) => n.id === f.id)) nodes.push({ id: f.id, type: "finding", label: f.title });
    edges.push({ from: input.runId, to: f.id, relation: "adopted" });
  }

  if (input.humanReviewDecision) {
    const decisionId = `${input.runId}:decision`;
    nodes.push({ id: decisionId, type: "decision", label: input.humanReviewDecision });
    edges.push({ from: input.runId, to: decisionId, relation: "reviewed_as" });
  }

  for (const linkedRunId of input.linkedRunIds) {
    nodes.push({ id: linkedRunId, type: "linked_run", label: `Linked run ${linkedRunId.slice(0, 8)}` });
    edges.push({ from: linkedRunId, to: input.runId, relation: "supports" });
  }

  for (const adoption of input.resultAdoptions ?? []) {
    const resultId = `grant:${adoption.launchGrantId}`;
    nodes.push({ id: resultId, type: "provider_result", label: "Returned provider result" });
    nodes.push({ id: adoption.id, type: "adoption", label: `${adoption.decision}: ${adoption.planEffect}` });
    edges.push({ from: resultId, to: adoption.id, relation: "considered" });
    edges.push({ from: adoption.id, to: input.runId, relation: "changed_plan" });
  }

  return { nodes, edges };
}
