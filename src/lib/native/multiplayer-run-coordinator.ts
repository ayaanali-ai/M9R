import { randomUUID } from "node:crypto";
import {
  MAX_ACTIVE_AGENTS,
  parseCancellationRequest,
  parseMultiplayerOperation,
  type CancellationRequest,
  type MultiplayerOperation,
  type MultiplayerRoster,
} from "./multiplayer-contract";

/**
 * Phase 2 run coordinator.
 *
 * This is the common cancellation fence for later provider, A2A, surface, and
 * desktop adapters. It is intentionally in-memory and provider-neutral: the
 * durable task store and provider transports remain the owners of their own
 * persistence/processes. A later adapter receives the action AbortSignal and
 * must re-check isCurrent before publishing any late result.
 */

export type RunActionState = "queued" | "running" | "completed" | "canceled";

export interface RunActionSnapshot extends MultiplayerOperation {
  readonly state: RunActionState;
  readonly canceledAt?: number;
  readonly cancellationId?: string;
}

export type RunCoordinatorEvent =
  | { readonly kind: "action-queued"; readonly action: RunActionSnapshot; readonly at: number }
  | { readonly kind: "action-started"; readonly action: RunActionSnapshot; readonly at: number }
  | { readonly kind: "action-completed"; readonly action: RunActionSnapshot; readonly at: number }
  | { readonly kind: "action-canceled"; readonly action: RunActionSnapshot; readonly at: number; readonly cancellation: CancellationRequest }
  | {
    readonly kind: "cancellation-propagated";
    readonly cancellation: CancellationRequest;
    readonly recipientAgentIds: readonly string[];
    readonly affectedActionIds: readonly string[];
    readonly at: number;
  };

export interface RunCoordinatorAction {
  readonly operation: MultiplayerOperation;
  readonly signal: AbortSignal;
  /** True only while this operation may still publish a result. */
  isCurrent(): boolean;
}

export type CoordinatorResult =
  | { readonly ok: true; readonly value: RunCoordinatorCancellationResult }
  | { readonly ok: false; readonly error: string };

export type QueueResult =
  | { readonly ok: true; readonly value: RunCoordinatorAction }
  | { readonly ok: false; readonly error: string };

export interface RunCoordinatorCancellationResult {
  readonly cancellationId: string;
  readonly duplicate: boolean;
  readonly affectedActionIds: readonly string[];
  readonly recipientAgentIds: readonly string[];
}

export interface RunCoordinatorSnapshot {
  readonly runId: string;
  readonly stopped: boolean;
  readonly canceledAgentIds: readonly string[];
  readonly canceledBranchIds: readonly string[];
  readonly actions: readonly RunActionSnapshot[];
}

export interface RunCoordinator {
  readonly runId: string;
  readonly roster: MultiplayerRoster;
  /** Queue one revisioned operation. Duplicate operation IDs are rejected. */
  queue(operation: MultiplayerOperation): QueueResult;
  /** Start only a queued operation that has not been canceled by its scope. */
  start(operationId: string): boolean;
  /** Complete an action only if it is still current; late completion after stop returns false. */
  complete(operationId: string): boolean;
  /** Apply one validated cancellation request and propagate it to affected agents. */
  requestCancellation(request: CancellationRequest): CoordinatorResult;
  stopAgent(agentId: string, reason?: string): CoordinatorResult;
  stopBranch(branchId: string, reason?: string): CoordinatorResult;
  stopRun(reason?: string): CoordinatorResult;
  /** Event-driven propagation; callers do not poll for cancellation state. */
  subscribe(listener: (event: RunCoordinatorEvent) => void): () => void;
  isCurrent(operationId: string): boolean;
  snapshot(): RunCoordinatorSnapshot;
}

export interface RunCoordinatorOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

type ActionRecord = {
  operation: MultiplayerOperation;
  state: RunActionState;
  controller: AbortController;
  canceledAt?: number;
  cancellationId?: string;
};

function safeReason(reason: string | undefined, fallback: string): string {
  const clean = reason?.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  return (clean || fallback).slice(0, 160);
}

function result(value: RunCoordinatorCancellationResult): CoordinatorResult {
  return { ok: true, value };
}

function errorResult(error: string): CoordinatorResult {
  return { ok: false, error };
}

function queueErrorResult(error: string): QueueResult {
  return { ok: false, error };
}

function actionSnapshot(record: ActionRecord): RunActionSnapshot {
  return {
    ...record.operation,
    state: record.state,
    ...(record.canceledAt === undefined ? {} : { canceledAt: record.canceledAt }),
    ...(record.cancellationId === undefined ? {} : { cancellationId: record.cancellationId }),
  };
}

function affectedByCancellation(operation: MultiplayerOperation, cancellation: CancellationRequest): boolean {
  if (operation.runId !== cancellation.scope.runId) return false;
  switch (cancellation.scope.scope) {
    case "run": return true;
    case "branch": return operation.branchId === cancellation.scope.branchId;
    case "agent": return operation.branchId === cancellation.scope.branchId && operation.agentId === cancellation.scope.agentId;
    case "operation": return operation.operationId === cancellation.scope.operationId;
  }
}

function recipientsForCancellation(roster: MultiplayerRoster, cancellation: CancellationRequest): string[] {
  const agents = roster.agents.filter((agent) => {
    if (agent.branchId === undefined || agent.branchId === "") return false;
    switch (cancellation.scope.scope) {
      case "run": return true;
      case "branch": return agent.branchId === cancellation.scope.branchId;
      case "agent": return agent.branchId === cancellation.scope.branchId && agent.agentId === cancellation.scope.agentId;
      case "operation": return agent.branchId === cancellation.scope.branchId && agent.agentId === cancellation.scope.agentId;
    }
  });
  return agents.map((agent) => agent.agentId);
}

function createCancellation(
  runId: string,
  scope: CancellationRequest["scope"],
  reason: string,
  now: () => number,
  idFactory: () => string,
): CancellationRequest {
  return parseCancellationRequest({
    schemaVersion: 1,
    cancellationId: idFactory(),
    scope: { ...scope, runId },
    reason: safeReason(reason, "Canceled by the owner."),
    requestedAt: now(),
  });
}

/** Create the one run-level cancellation authority for a multiplayer run. */
export function createMultiplayerRunCoordinator(
  roster: MultiplayerRoster,
  options: RunCoordinatorOptions = {},
): RunCoordinator {
  const parsedRoster = roster;
  if (parsedRoster.agents.length < 1 || parsedRoster.agents.length > MAX_ACTIVE_AGENTS) {
    throw new Error(`M9R run roster must contain between 1 and ${MAX_ACTIVE_AGENTS} agents.`);
  }
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const actions = new Map<string, ActionRecord>();
  const cancellations = new Set<string>();
  const canceledAgents = new Set<string>();
  const canceledBranches = new Set<string>();
  const listeners = new Set<(event: RunCoordinatorEvent) => void>();
  let stopped = false;

  const knownAgents = new Map(parsedRoster.agents.map((agent) => [agent.agentId, agent]));

  const emit = (event: RunCoordinatorEvent): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* observers cannot break cancellation */ }
    }
  };

  const coordinator: RunCoordinator = {
    runId: parsedRoster.runId,
    roster: parsedRoster,

    queue(operation) {
      let parsed: MultiplayerOperation;
      try { parsed = parseMultiplayerOperation(operation); }
      catch (error) { return queueErrorResult(error instanceof Error ? error.message : "invalid multiplayer operation"); }
      if (parsed.runId !== parsedRoster.runId) return queueErrorResult("operation belongs to a different M9R run");
      const agent = knownAgents.get(parsed.agentId);
      if (!agent) return queueErrorResult("operation references an agent outside the run roster");
      if (agent.branchId !== parsed.branchId) return queueErrorResult("operation branch does not match its agent identity");
      if (actions.has(parsed.operationId)) return queueErrorResult("operation ID is already queued in this run");
      if (stopped || canceledAgents.has(parsed.agentId) || canceledBranches.has(parsed.branchId)) {
        return queueErrorResult("operation was rejected because its run, branch, or agent is canceled");
      }
      const record: ActionRecord = { operation: parsed, state: "queued", controller: new AbortController() };
      actions.set(parsed.operationId, record);
      emit({ kind: "action-queued", action: actionSnapshot(record), at: now() });
      return { ok: true, value: {
        operation: parsed,
        signal: record.controller.signal,
        isCurrent: () => coordinator.isCurrent(parsed.operationId),
      } };
    },

    start(operationId) {
      const record = actions.get(operationId);
      if (!record || record.state !== "queued" || stopped || canceledAgents.has(record.operation.agentId) || canceledBranches.has(record.operation.branchId)) return false;
      record.state = "running";
      emit({ kind: "action-started", action: actionSnapshot(record), at: now() });
      return true;
    },

    complete(operationId) {
      const record = actions.get(operationId);
      if (!record || record.state === "canceled") return false;
      if (record.state === "completed") return true;
      if (stopped || canceledAgents.has(record.operation.agentId) || canceledBranches.has(record.operation.branchId)) return false;
      record.state = "completed";
      emit({ kind: "action-completed", action: actionSnapshot(record), at: now() });
      return true;
    },

    requestCancellation(request) {
      let parsed: CancellationRequest;
      try { parsed = parseCancellationRequest(request); }
      catch (error) { return errorResult(error instanceof Error ? error.message : "invalid cancellation request"); }
      if (parsed.scope.runId !== parsedRoster.runId) return errorResult("cancellation belongs to a different M9R run");
      if (cancellations.has(parsed.cancellationId)) {
        return result({ cancellationId: parsed.cancellationId, duplicate: true, affectedActionIds: [], recipientAgentIds: [] });
      }
      if (parsed.scope.scope === "agent" || parsed.scope.scope === "operation") {
        if (!knownAgents.has(parsed.scope.agentId)) return errorResult("cancellation references an agent outside the run roster");
      }
      const branchId = parsed.scope.scope === "run" ? undefined : parsed.scope.branchId;
      if (branchId !== undefined && !parsedRoster.agents.some((agent) => agent.branchId === branchId)) {
        return errorResult("cancellation references a branch outside the run roster");
      }
      cancellations.add(parsed.cancellationId);
      if (parsed.scope.scope === "run") stopped = true;
      if (parsed.scope.scope === "branch") canceledBranches.add(parsed.scope.branchId);
      if (parsed.scope.scope === "agent") canceledAgents.add(parsed.scope.agentId);

      const affectedActionIds: string[] = [];
      for (const record of actions.values()) {
        if (record.state === "completed" || record.state === "canceled" || !affectedByCancellation(record.operation, parsed)) continue;
        record.state = "canceled";
        record.canceledAt = now();
        record.cancellationId = parsed.cancellationId;
        record.controller.abort(new Error(parsed.reason));
        affectedActionIds.push(record.operation.operationId);
        emit({ kind: "action-canceled", action: actionSnapshot(record), at: record.canceledAt, cancellation: parsed });
      }
      const recipientAgentIds = recipientsForCancellation(parsedRoster, parsed);
      emit({ kind: "cancellation-propagated", cancellation: parsed, recipientAgentIds, affectedActionIds, at: now() });
      return result({ cancellationId: parsed.cancellationId, duplicate: false, affectedActionIds, recipientAgentIds });
    },

    stopAgent(agentId, reason = "Agent stopped by the owner.") {
      const agent = knownAgents.get(agentId);
      if (!agent) return errorResult("agent is not part of this run");
      return coordinator.requestCancellation(createCancellation(
        parsedRoster.runId,
        { scope: "agent", runId: parsedRoster.runId, branchId: agent.branchId, agentId },
        reason,
        now,
        idFactory,
      ));
    },

    stopBranch(branchId, reason = "Branch stopped by the owner.") {
      if (!parsedRoster.agents.some((agent) => agent.branchId === branchId)) return errorResult("branch is not part of this run");
      return coordinator.requestCancellation(createCancellation(
        parsedRoster.runId,
        { scope: "branch", runId: parsedRoster.runId, branchId },
        reason,
        now,
        idFactory,
      ));
    },

    stopRun(reason = "Run stopped by the owner.") {
      return coordinator.requestCancellation(createCancellation(
        parsedRoster.runId,
        { scope: "run", runId: parsedRoster.runId },
        reason,
        now,
        idFactory,
      ));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    isCurrent(operationId) {
      const record = actions.get(operationId);
      return Boolean(record && (record.state === "queued" || record.state === "running")
        && !stopped
        && !canceledAgents.has(record.operation.agentId)
        && !canceledBranches.has(record.operation.branchId)
        && !record.controller.signal.aborted);
    },

    snapshot() {
      return {
        runId: parsedRoster.runId,
        stopped,
        canceledAgentIds: [...canceledAgents],
        canceledBranchIds: [...canceledBranches],
        actions: [...actions.values()].map(actionSnapshot),
      };
    },
  };

  return coordinator;
}
