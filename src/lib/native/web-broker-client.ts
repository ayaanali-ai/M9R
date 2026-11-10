import { readFileSync } from "node:fs";
import type { WebAgentMessage } from "./web-broker-core";
import { requestOwnerPipe } from "./owner-pipe";
import { DEFAULT_BROKER_PORT } from "./web-broker-paths";
import type { TaskCompletionReport } from "./task-completion-contract";
import type { TaskStageMode } from "./task-desktop-stage";
import type { MultiplayerA2ASendInput, MultiplayerSendResult } from "./multiplayer-runtime";
import { parseA2AMessage, type A2AMessage } from "./multiplayer-contract";
import { taskContextSchema, type TaskContext } from "./multiplayer-task-context";

const MAX_STAGE_REQUEST_TIMEOUT_MS = 70_000;
const CURSOR_PRIME_TIMEOUT_MS = 5_000;
/** State writes use the same owner pipe but may serialize a large, locked local snapshot. */
const AGENT_STORE_REQUEST_TIMEOUT_MS = 15_000;

/** Common response envelope for stage operations and the provider-neutral computer-use adapter. */
export interface StageClientResult {
  ok: boolean;
  result?: unknown;
  data?: unknown;
  error?: string;
  code?: string;
  /** Specific pre-dispatch gate that stopped delivery, when the broker reported one. */
  gateCode?: string;
  dispatchState?: "not-dispatched" | "dispatched" | "unknown" | string;
  nextStep?: string;
  recovery?: unknown;
}

export interface WebBrokerClient {
  /** Durable task/inbox mutations performed by the owner broker under its own M9R-home ACL. */
  submitAgentTask?(token: string, to: string, goal: string): Promise<{ ok: boolean; taskId?: string; created?: boolean; error?: string }>;
  /** Structured provider-neutral teammate message. Kept separate from legacy task delivery. */
  sendA2A?(token: string, input: MultiplayerA2ASendInput): Promise<MultiplayerSendResult>;
  /** Shared task state and conflict-safe work ownership for A2A coordination. */
  getMultiplayerTaskContext?(token: string, taskId: string): Promise<{ ok: boolean; context?: TaskContext; error?: string }>;
  claimMultiplayerWork?(token: string, input: { taskId: string; assignmentId: string; workKey: string; summary: string }): Promise<{ ok: boolean; duplicate?: boolean; context?: TaskContext; error?: string }>;
  completeMultiplayerWork?(token: string, taskId: string, assignmentId: string): Promise<{ ok: boolean; duplicate?: boolean; context?: TaskContext; error?: string }>;
  releaseMultiplayerWork?(token: string, taskId: string, assignmentId: string): Promise<{ ok: boolean; duplicate?: boolean; context?: TaskContext; error?: string }>;
  claimAgentInbox?(token: string, taskIds: readonly string[]): Promise<{ ok: boolean; taskIds?: string[]; error?: string }>;
  /** Acknowledge only completed teammate replies addressed to the authenticated sending session. */
  markAgentResultsShown?(token: string, taskIds: readonly string[]): Promise<{ ok: boolean; error?: string }>;
  advanceAgentInboxCursor?(token: string, seq: number): Promise<{ ok: boolean; error?: string }>;
  recordAgentTaskResult?(token: string, taskId: string, summary: string, completion?: TaskCompletionReport): Promise<{ ok: boolean; error?: string }>;
  taskStageApp?(token: string, taskId: string, appId?: string, mode?: TaskStageMode, operationId?: string): Promise<StageClientResult>;
  taskStageAction?(token: string, taskId: string, action: unknown, mode?: TaskStageMode, operationId?: string, expectedMutationRevision?: number): Promise<StageClientResult>;
  prepareTaskStage?(token: string, taskId: string, mode?: TaskStageMode, timeoutMs?: number, options?: { bindForeground?: boolean }): Promise<{ ok: boolean; stage?: unknown; error?: string }>;
  /** Best-effort delivery-time cursor prime; never blocks the task transport. */
  primeAgentCursor?(token: string, taskId: string): Promise<StageClientResult>;
  notifyMessage?(message: WebAgentMessage): Promise<boolean>;
  /** Ask the local AWARE ledger before a browser-room agent writes a task into another member's inbox. */
  authorizeRoomMessage?(sender: string, recipient: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Every agent configured in this room (for m9r_agents; a web session has no endpoint registry entry otherwise). */
  listRoomAgents?(): Promise<string[]>;
  /** A native (non-worker) agent's turn just ended -- mark its cursor "Done" instead of leaving it on whatever the
   * last individual browser action happened to be. Called from that agent's own Stop hook. */
  markDone?(agent: string, provider: string, sessionId: string): Promise<boolean>;
}

export interface WebBrokerClientOptions {
  keyPath: string;
  port?: number;
  ownerPipePath?: string;
  fetchImpl?: typeof fetch;
}

type StructuredA2AStoreResponse = {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  message?: unknown;
  recipientAgentIds?: unknown;
  taskId?: unknown;
  delivery?: unknown;
};

type SharedTaskStateResponse = { ok: boolean; context?: unknown; duplicate?: boolean; error?: string };

function parseSharedTaskStateResponse(result: SharedTaskStateResponse, error: string):
  | { ok: true; context: TaskContext; duplicate?: boolean }
  | { ok: false; error: string } {
  if (!result.ok) return { ok: false, error: result.error ?? error };
  try {
    const context = taskContextSchema.parse(result.context);
    return { ok: true, context, ...(result.duplicate === undefined ? {} : { duplicate: result.duplicate }) };
  } catch {
    return { ok: false, error: "The owner broker returned invalid shared task state." };
  }
}

function stageTransportFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
    if (value.name === "TimeoutError" || value.name === "AbortError") {
      return "The local M9R desktop-stage request timed out before the broker responded.";
    }
    switch (value.cause?.code) {
      case "ECONNREFUSED": return "The local M9R web broker refused the desktop-stage request.";
      case "ECONNRESET": return "The local M9R web broker closed the desktop-stage request before replying.";
      case "EACCES": case "EPERM": return "Windows denied the local desktop-stage broker connection.";
    }
    if (typeof value.message === "string" && value.message.trim()) {
      return `The local M9R desktop-stage request failed: ${value.message.trim().slice(0, 180)}`;
    }
  }
  return "The local M9R desktop-stage request failed with an unknown transport error.";
}

async function agentStoreRequest<T extends { ok: boolean; error?: string }>(input: {
  ownerPipePath?: string;
  body: Record<string, unknown>;
}): Promise<T> {
  if (!input.ownerPipePath) {
    return { ok: false, error: "The owner broker task-state pipe is not configured; no M9R task state was changed." } as T;
  }
  try {
    const result: unknown = await requestOwnerPipe(input.ownerPipePath, {
      method: "POST",
      path: "/web/mcp/store",
      body: input.body,
    }, AGENT_STORE_REQUEST_TIMEOUT_MS);
    if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
      return { ok: false, error: "The owner broker did not confirm this M9R state write before the timeout; it may already have been applied. Retry the same idempotent operation once rather than assuming it was lost." } as T;
    }
    return result as T;
  } catch {
    return { ok: false, error: "The owner broker could not receive this M9R state write; no task was accepted." } as T;
  }
}

async function taskStageRequest<T extends { ok: boolean; error?: string }>(input: {
  fetchImpl: typeof fetch;
  keyPath: string;
  url: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  operationId?: string;
  ownerPipePath?: string;
}): Promise<T> {
  if (input.ownerPipePath) {
    const result = await requestOwnerPipe<T>(input.ownerPipePath, {
      method: "POST", path: new URL(input.url).pathname, body: input.body,
    }, input.timeoutMs);
    if (result && typeof result === "object" && typeof result.ok === "boolean") return result;
    return { ok: false, error: input.operationId
      ? `The desktop-stage IPC response was lost; operation ${input.operationId} may have been applied. Do not replay it. Capture the stage and inspect its state.`
      : "The local desktop-stage IPC endpoint did not return a valid response. No HTTP fallback was attempted." } as T;
  }
  let key: string;
  try {
    key = readFileSync(input.keyPath, "utf8").trim();
  } catch {
    return { ok: false, error: "The local M9R desktop-stage broker key could not be read." } as T;
  }
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-m9r-key": key },
      body: JSON.stringify(input.body),
      // Stage launch/actions may legitimately take longer than ordinary broker
      // RPCs while a native window is starting and being attached. Keep a hard
      // ceiling, but honor the deadline each stage method selected.
      signal: AbortSignal.timeout(Math.max(1, Math.min(input.timeoutMs, MAX_STAGE_REQUEST_TIMEOUT_MS))),
    });
  } catch (error) {
    if (input.operationId && error && typeof error === "object"
      && ((error as { name?: unknown }).name === "TimeoutError" || (error as { name?: unknown }).name === "AbortError")) {
      return { ok: false, error: `The desktop-stage request timed out after dispatch; operation ${input.operationId} may have been applied. Do not replay it. Capture the stage and inspect its state before issuing a new action.` } as T;
    }
    return { ok: false, error: stageTransportFailure(error) } as T;
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return { ok: false, error: `The local M9R web broker returned invalid JSON (HTTP ${response.status}).` } as T;
  }
  if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
    return { ok: false, error: `The local M9R web broker returned an invalid stage response (HTTP ${response.status}).` } as T;
  }
  if (!response.ok && (result as { ok: boolean }).ok) {
    return { ok: false, error: `The local M9R web broker rejected the stage request (HTTP ${response.status}).` } as T;
  }
  return result as T;
}

export function createWebBrokerClient(options: WebBrokerClientOptions): WebBrokerClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = `http://127.0.0.1:${options.port ?? DEFAULT_BROKER_PORT}`;
  return {
    async submitAgentTask(token, to, goal) {
      return agentStoreRequest({ ownerPipePath: options.ownerPipePath, body: { action: "send", token, to, goal } });
    },
    async sendA2A(token, input) {
      const result = await agentStoreRequest<StructuredA2AStoreResponse>({
        ownerPipePath: options.ownerPipePath,
        body: { action: "a2a", token, ...input },
      });
      if (!result.ok) return { ok: false, error: result.error ?? "The owner broker rejected the structured teammate message." };
      if (!result.message || !Array.isArray(result.recipientAgentIds)
        || result.recipientAgentIds.some((agentId) => typeof agentId !== "string")) {
        return { ok: false, error: "The owner broker returned an incomplete structured teammate response." };
      }
      let message: A2AMessage;
      try {
        message = parseA2AMessage(result.message);
      } catch {
        return { ok: false, error: "The owner broker returned an invalid structured teammate message." };
      }
      const rawDelivery = result.delivery && typeof result.delivery === "object" ? result.delivery as Record<string, unknown> : undefined;
      const states = ["queued", "already-present", "pending", "uncertain", "completed", "held-no-progress", "not-configured", "failed"] as const;
      const deliveryState = rawDelivery?.state;
      const delivery = rawDelivery && states.some((state) => state === deliveryState)
        ? {
          state: deliveryState as typeof states[number],
          ...(typeof rawDelivery.taskId === "string" ? { taskId: rawDelivery.taskId } : {}),
          ...(typeof rawDelivery.created === "boolean" ? { created: rawDelivery.created } : {}),
          ...(typeof rawDelivery.error === "string" ? { error: rawDelivery.error } : {}),
        }
        : { state: "not-configured" as const, error: "The owner broker did not return a recipient-inbox delivery receipt." };
      return {
        ok: true,
        duplicate: result.duplicate === true,
        message,
        recipientAgentIds: result.recipientAgentIds as string[],
        delivery,
      };
    },
    async getMultiplayerTaskContext(token, taskId) {
      const result = await agentStoreRequest<SharedTaskStateResponse>({
        ownerPipePath: options.ownerPipePath,
        body: { action: "task_state", token, taskId },
      });
      return parseSharedTaskStateResponse(result, "The owner broker could not read shared task state.");
    },
    async claimMultiplayerWork(token, input) {
      const result = await agentStoreRequest<SharedTaskStateResponse>({
        ownerPipePath: options.ownerPipePath,
        body: { action: "claim_work", token, ...input },
      });
      return parseSharedTaskStateResponse(result, "The owner broker could not claim shared work.");
    },
    async completeMultiplayerWork(token, taskId, assignmentId) {
      const result = await agentStoreRequest<SharedTaskStateResponse>({
        ownerPipePath: options.ownerPipePath,
        body: { action: "complete_work", token, taskId, assignmentId },
      });
      return parseSharedTaskStateResponse(result, "The owner broker could not complete shared work.");
    },
    async releaseMultiplayerWork(token, taskId, assignmentId) {
      const result = await agentStoreRequest<SharedTaskStateResponse>({
        ownerPipePath: options.ownerPipePath,
        body: { action: "release_work", token, taskId, assignmentId },
      });
      return parseSharedTaskStateResponse(result, "The owner broker could not release shared work.");
    },
    async claimAgentInbox(token, taskIds) {
      return agentStoreRequest({ ownerPipePath: options.ownerPipePath, body: { action: "claim_inbox", token, taskIds } });
    },
    async markAgentResultsShown(token, taskIds) {
      return agentStoreRequest({ ownerPipePath: options.ownerPipePath, body: { action: "mark_results_shown", token, taskIds } });
    },
    async advanceAgentInboxCursor(token, seq) {
      return agentStoreRequest({ ownerPipePath: options.ownerPipePath, body: { action: "cursor", token, seq } });
    },
    async recordAgentTaskResult(token, taskId, summary, completion) {
      return agentStoreRequest({ ownerPipePath: options.ownerPipePath, body: { action: "result", token, taskId, summary, ...(completion ? { completion } : {}) } });
    },
    async taskStageApp(token, taskId, appId, mode = "owner-preview", operationId) {
      return taskStageRequest({ fetchImpl: doFetch, keyPath: options.keyPath, ownerPipePath: options.ownerPipePath,
        url: `${baseUrl}/web/stage/${appId === undefined ? "close" : "launch"}`,
        body: { token, taskId, mode, ...(appId === undefined ? {} : { appId }), ...(operationId ? { operationId } : {}) },
        timeoutMs: 70_000, ...(operationId ? { operationId } : {}) });
    },
    async taskStageAction(token, taskId, action, mode = "owner-preview", operationId, expectedMutationRevision) {
      return taskStageRequest({ fetchImpl: doFetch, keyPath: options.keyPath, ownerPipePath: options.ownerPipePath, url: `${baseUrl}/web/stage/action`,
        body: { token, taskId, action, mode, ...(operationId ? { operationId } : {}),
          ...(expectedMutationRevision === undefined ? {} : { expectedMutationRevision }) },
        timeoutMs: 70_000, ...(operationId ? { operationId } : {}) });
    },
    async prepareTaskStage(token, taskId, mode = "owner-preview", timeoutMs = 15_000, prepareOptions) {
      return taskStageRequest({ fetchImpl: doFetch, keyPath: options.keyPath, ownerPipePath: options.ownerPipePath, url: `${baseUrl}/web/stage/prepare`,
        body: { token, taskId, mode, ...(prepareOptions?.bindForeground ? { bindForeground: true } : {}) }, timeoutMs });
    },
    async primeAgentCursor(token, taskId) {
      return taskStageRequest({ fetchImpl: doFetch, keyPath: options.keyPath, ownerPipePath: options.ownerPipePath,
        url: `${baseUrl}/web/stage/prime-cursor`, body: { token, taskId }, timeoutMs: CURSOR_PRIME_TIMEOUT_MS });
    },
    async notifyMessage(message) {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return false;
      }
      try {
        const response = await doFetch(`${baseUrl}/web/message`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) return false;
        const result: unknown = await response.json();
        return typeof result === "object" && result !== null && "ok" in result && (result as { ok?: unknown }).ok === true;
      } catch {
        // A browser overlay is a best-effort surface; the durable inbox send remains successful.
        return false;
      }
    },
    async authorizeRoomMessage(sender, recipient) {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return { ok: false, error: "AWARE room membership could not be checked; the local broker key is unavailable" };
      }
      try {
        const response = await doFetch(`${baseUrl}/web/aware/messages/authorize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ sender, recipient }),
          signal: AbortSignal.timeout(2_000),
        });
        const result: unknown = await response.json();
        if (response.ok && typeof result === "object" && result !== null && "ok" in result && (result as { ok?: unknown }).ok === true) {
          return { ok: true };
        }
        const error = typeof result === "object" && result !== null && "error" in result && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error
          : "AWARE room membership denied the message";
        return { ok: false, error };
      } catch {
        return { ok: false, error: "AWARE room membership could not be checked; the local broker is unavailable" };
      }
    },
    async listRoomAgents() {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return [];
      }
      try {
        const response = await doFetch(`${baseUrl}/web/agents`, { headers: { "x-m9r-key": key }, signal: AbortSignal.timeout(2_000) });
        const result: unknown = await response.json();
        const agents = result && typeof result === "object" ? (result as { agents?: unknown }).agents : undefined;
        return Array.isArray(agents) ? agents.filter((a): a is string => typeof a === "string") : [];
      } catch {
        return [];
      }
    },
    async markDone(agent, provider, sessionId) {
      if (!sessionId || sessionId.length > 128) return false;
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return false;
      }
      try {
        const response = await doFetch(`${baseUrl}/web/agent-done`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ agent, provider, sessionId }),
          signal: AbortSignal.timeout(2_500),
        });
        if (!response.ok) return false;
        const result: unknown = await response.json();
        return typeof result === "object" && result !== null &&
          "ok" in result && (result as { ok?: unknown }).ok === true &&
          "marked" in result && (result as { marked?: unknown }).marked === true;
      } catch {
        // Best-effort: a missing/unreachable broker must never fail the agent's own turn just because the pill
        // could not be told it finished.
        return false;
      }
    },
  };
}
