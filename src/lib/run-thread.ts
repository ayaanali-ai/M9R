/**
 * Run Thread — OathLock V2 Phase 3
 * ----------------------------------------------------------------------------
 * The chronological view of one Run Room: Dispatches and Responses merged and
 * sorted by time. Pure/IO-free — callers fetch the two lists (dispatch-service,
 * response-service) and pass them in.
 */

import type { WireEntry } from "./dispatch-service";
import type { ResponseEntry } from "./response-service";
import { normalizeAgentKind, type AgentKindKey } from "./agent-workspace-data";

export interface RunThreadEntry {
  id: string;
  kind: "dispatch" | "response";
  type: string;
  sender: string;
  /** Canonical identity supplied by the authoritative run record, never text-matched in UI. */
  senderAgentKind: AgentKindKey | null;
  /** Structured role distinguishes human/operator responses from agent results. */
  senderRole?: "agent" | "operator";
  text: string;
  resolutionState: string;
  createdAt: string;
  /** Only set for responses that answer a specific dispatch. */
  respondsToDispatchId?: string | null;
  targetConnectionId?: string | null;
  assignmentId?: string | null;
  routingReason?: string | null;
  approvalState?: string;
}

export function buildRunThread(
  dispatches: WireEntry[],
  responses: ResponseEntry[],
  context: { sourceAgentKind?: string | null } = {},
): RunThreadEntry[] {
  const sourceAgentKind = context.sourceAgentKind ? normalizeAgentKind(context.sourceAgentKind) : "other";
  const dispatchEntries: RunThreadEntry[] = dispatches.map((d) => ({
    id: d.id,
    kind: "dispatch",
    type: d.type,
    sender: d.sender,
    senderAgentKind: sourceAgentKind,
    text: d.summary,
    resolutionState: d.resolutionState,
    createdAt: d.createdAt,
    targetConnectionId: d.targetConnectionId,
    assignmentId: d.assignmentId,
    routingReason: d.routingReason,
    approvalState: d.approvalState,
  }));
  const responseEntries: RunThreadEntry[] = responses.map((r) => ({
    id: r.id,
    kind: "response",
    type: r.type,
    sender: r.sender,
    senderAgentKind: r.senderRole === "agent" ? sourceAgentKind : null,
    senderRole: r.senderRole,
    text: r.body,
    resolutionState: r.resolutionState,
    createdAt: r.createdAt,
    respondsToDispatchId: r.dispatchId,
  }));
  return [...dispatchEntries, ...responseEntries].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
