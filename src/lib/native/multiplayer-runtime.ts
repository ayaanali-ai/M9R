import { createHash } from "node:crypto";
import {
  createMultiplayerA2ARouter,
  type MultiplayerA2ARouter,
} from "./multiplayer-a2a";
import {
  createMultiplayerRunCoordinator,
  type RunCoordinator,
} from "./multiplayer-run-coordinator";
import {
  createTaskContext,
  type TaskContext,
  type TaskContextStore,
  type TaskControl,
  type TaskParticipant,
  type TaskProgressWitness,
} from "./multiplayer-task-context";
import {
  parseA2AMessage,
  type A2AMessage,
  type A2AMessageKind,
  type A2AProgressKind,
  type MultiplayerAgent,
  type MultiplayerRoster,
} from "./multiplayer-contract";
import type { VerifiedIdentity } from "./identity-core";
import { MAX_AGENT_REPLY_DEPTH } from "./inbox-core";

const DEFAULT_A2A_RETRY_WINDOW_MS = 30_000;

/**
 * The owner-broker coordination boundary.  The contracts in the multiplayer
 * modules are deliberately pure; this adapter is the missing live seam that
 * binds them to authenticated provider identities and the durable task path.
 * It never owns provider credentials or desktop input.
 */
export interface MultiplayerDelivery {
  (message: A2AMessage): Promise<{ ok: boolean; taskId?: string; taskIds?: readonly string[]; error?: string }> | { ok: boolean; taskId?: string; taskIds?: readonly string[]; error?: string };
}

export interface MultiplayerDeliveryReceipt {
  readonly state: "queued" | "pending" | "partial" | "failed";
  readonly taskIds: readonly string[];
  readonly error?: string;
}

export interface MultiplayerA2ASendInput {
  readonly to: string;
  readonly summary: string;
  readonly kind?: A2AMessageKind;
  readonly priority?: "low" | "normal" | "high" | "urgent";
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly details?: Record<string, string | number | boolean | null>;
  readonly idempotencyKey?: string;
  readonly replyToMessageId?: string;
  readonly supersedesMessageId?: string;
  readonly progressFingerprint?: string;
  readonly progressKind?: A2AProgressKind;
  readonly replyDepth?: number;
}

export interface MultiplayerRuntimeSnapshot {
  readonly roster: MultiplayerRoster;
  readonly a2a: readonly A2AMessage[];
  readonly tasks: readonly TaskContext[];
  readonly run: ReturnType<RunCoordinator["snapshot"]>;
}

export type MultiplayerSendResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly message: A2AMessage; readonly recipientAgentIds: readonly string[]; readonly delivery?: MultiplayerDeliveryReceipt }
  | { readonly ok: false; readonly error: string };

export interface MultiplayerRuntime {
  readonly runId: string;
  readonly roster: MultiplayerRoster;
  send(identity: VerifiedIdentity, input: MultiplayerA2ASendInput): MultiplayerSendResult;
  sendFromHandle(senderHandle: string, senderProvider: string, input: MultiplayerA2ASendInput): MultiplayerSendResult;
  applyControl(control: TaskControl): { ok: boolean; error?: string; context?: TaskContext };
  recordProgress(taskId: string, witness: TaskProgressWitness): { ok: boolean; error?: string; context?: TaskContext };
  snapshot(): MultiplayerRuntimeSnapshot;
  subscribe(listener: (message: A2AMessage) => void): () => void;
  setDelivery(delivery: MultiplayerDelivery | undefined): void;
}

function safeHandle(value: string): string {
  return value.replace(/^@+/, "").trim().toLowerCase();
}

function safeId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function participants(roster: MultiplayerRoster): TaskParticipant[] {
  return roster.agents.map((agent) => ({ agentId: agent.agentId, branchId: agent.branchId, provider: agent.provider }));
}

function normalizeDetails(details: MultiplayerA2ASendInput["details"]): MultiplayerA2ASendInput["details"] | undefined {
  if (!details) return undefined;
  const entries = Object.entries(details).slice(0, 32).map(([key, value]) => [key.slice(0, 128), value] as const);
  return Object.fromEntries(entries);
}

export function createMultiplayerRuntime(input: {
  roster: MultiplayerRoster;
  now?: () => number;
  delivery?: MultiplayerDelivery;
}): MultiplayerRuntime {
  const now = input.now ?? Date.now;
  const roster = input.roster;
  const byHandle = new Map(roster.agents.map((agent) => [safeHandle(agent.handle ?? agent.agentId), agent]));
  const router: MultiplayerA2ARouter = createMultiplayerA2ARouter(roster, { now });
  const coordinator = createMultiplayerRunCoordinator(roster, { now });
  const contexts = new Map<string, TaskContextStore>();
  const subscribers = new Set<(message: A2AMessage) => void>();
  const deliveryReceipts = new Map<string, MultiplayerDeliveryReceipt>();
  let delivery = input.delivery;

  const rememberDelivery = (messageId: string, result: { ok: boolean; taskId?: string; taskIds?: readonly string[]; error?: string }): MultiplayerDeliveryReceipt => {
    const taskIds = [...new Set([...(result.taskIds ?? []), ...(result.taskId ? [result.taskId] : [])])].slice(0, 16);
    const receipt: MultiplayerDeliveryReceipt = result.ok && taskIds.length > 0
      ? { state: "queued", taskIds }
      : !result.ok && taskIds.length > 0
        ? { state: "partial", taskIds, ...(result.error ? { error: result.error.slice(0, 300) } : {}) }
        : { state: "failed", taskIds: [], error: (result.error || "The delivery adapter did not confirm a durable task ID.").slice(0, 300) };
    deliveryReceipts.set(messageId, receipt);
    while (deliveryReceipts.size > 4096) {
      const oldest = deliveryReceipts.keys().next().value;
      if (!oldest) break;
      deliveryReceipts.delete(oldest);
    }
    return receipt;
  };

  const contextFor = (taskId: string, conversationId: string): TaskContextStore => {
    const existing = contexts.get(taskId);
    if (existing) return existing;
    const created = createTaskContext({
      taskId,
      conversationId,
      runId: roster.runId,
      participants: participants(roster),
      now: now(),
    });
    contexts.set(taskId, created);
    return created;
  };

  const attemptDelivery = (message: A2AMessage): void => {
    if (!delivery) return;
    try {
      const result = delivery(message);
      if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
        deliveryReceipts.set(message.messageId, { state: "pending", taskIds: [] });
        void Promise.resolve(result).then((settled) => {
          const receipt = rememberDelivery(message.messageId, settled);
          if (receipt.state === "failed" || receipt.state === "partial") {
            process.stderr.write(`[multiplayer-runtime] ${receipt.state} delivery of message ${message.messageId}: ${receipt.error ?? "no durable task"}\n`);
          }
        }).catch((error) => {
          const receipt = rememberDelivery(message.messageId, { ok: false, error: error instanceof Error ? error.message : String(error) });
          process.stderr.write(`[multiplayer-runtime] delivery of message ${message.messageId} failed: ${receipt.error}\n`);
        });
      } else {
        const receipt = rememberDelivery(message.messageId, result as { ok: boolean; taskId?: string; taskIds?: readonly string[]; error?: string });
        if (receipt.state === "failed" || receipt.state === "partial") {
          process.stderr.write(`[multiplayer-runtime] ${receipt.state} delivery of message ${message.messageId}: ${receipt.error ?? "no durable task"}\n`);
        }
      }
    } catch (error) {
      const receipt = rememberDelivery(message.messageId, { ok: false, error: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`[multiplayer-runtime] delivery of message ${message.messageId} failed: ${receipt.error}\n`);
    }
  };

  router.subscribe((event) => {
    if (event.kind === "message-duplicate") {
      const prior = deliveryReceipts.get(event.message.messageId);
      if (prior?.state === "failed" || prior?.state === "partial") attemptDelivery(event.message);
      return;
    }
    if (event.kind !== "message-accepted") return;
    const message = event.message;
    if (message.taskId) {
      const task = contextFor(message.taskId, message.conversationId ?? safeId("conversation", message.taskId));
      if (message.progressFingerprint && message.progressKind) {
        task.recordProgress({
          witnessId: message.messageId,
          kind: message.progressKind,
          stateFingerprint: message.progressFingerprint,
          summary: message.summary,
          at: message.createdAt,
        });
      }
    }
    for (const listener of subscribers) {
      try { listener(message); } catch { /* observers never own delivery */ }
    }
    // Acceptance and provider delivery are separate. A duplicate retry may
    // resume a failed/partial durable handoff, but never a pending or queued one.
    attemptDelivery(message);
  });

  const resolveSender = (handle: string, provider: string): MultiplayerAgent | undefined => {
    const normalized = safeHandle(handle);
    const configured = byHandle.get(normalized);
    if (configured) return configured;
    const agentId = safeId("agent", normalized);
    const branchId = safeId("branch", normalized);
    return { agentId, branchId, provider: provider.trim().slice(0, 160) || "unknown", handle: normalized };
  };

  const sendFromHandle = (senderHandle: string, senderProvider: string, inputValue: MultiplayerA2ASendInput): MultiplayerSendResult => {
    const sender = resolveSender(senderHandle, senderProvider);
    if (!sender) return { ok: false, error: "The sender is not part of the M9R multiplayer roster." };
    const recipient = byHandle.get(safeHandle(inputValue.to))
      ?? roster.agents.find((agent) => agent.agentId === inputValue.to);
    if (!recipient) return { ok: false, error: `@${safeHandle(inputValue.to)} is not part of the active M9R roster.` };
    if (recipient.agentId === sender.agentId) return { ok: false, error: "An agent cannot send a teammate message to itself." };
    const replyParent = inputValue.replyToMessageId
      ? router.history().find((message) => message.messageId === inputValue.replyToMessageId)
      : undefined;
    if (inputValue.replyToMessageId && !replyParent) return { ok: false, error: "A2A reply references an unknown message." };
    if (replyParent) {
      const parentRecipients = replyParent.recipient.kind === "agent" ? [replyParent.recipient.agentId] : replyParent.recipient.agentIds;
      if (!parentRecipients.includes(sender.agentId) || replyParent.agentId !== recipient.agentId) {
        return { ok: false, error: "A2A reply sender or recipient does not match the referenced teammate exchange." };
      }
    }
    const taskId = inputValue.taskId?.trim() || replyParent?.taskId;
    const conversationId = inputValue.conversationId?.trim() || replyParent?.conversationId
      || (taskId ? safeId("conversation", taskId) : safeId("conversation", `${sender.agentId}:${recipient.agentId}`));
    const callerIdempotencyKey = inputValue.idempotencyKey?.trim();
    const createdAt = now();
    const idempotencyKey = callerIdempotencyKey
      || safeId("a2a", `${sender.agentId}:${recipient.agentId}:${taskId ?? "room"}:${inputValue.summary}:${Math.floor(createdAt / DEFAULT_A2A_RETRY_WINDOW_MS)}`);
    const raw = {
      schemaVersion: 1 as const,
      runId: roster.runId,
      branchId: sender.branchId,
      agentId: sender.agentId,
      ...(taskId ? { taskId } : {}),
      conversationId,
      // The retry key (caller-provided, or a short content/time-bucket fallback)
      // reproduces the message ID. The fallback expires into a new identity so
      // repeated wording remains usable for a later deliberate handoff.
      messageId: safeId("message", `${sender.agentId}:${idempotencyKey}`),
      recipient: { kind: "agent" as const, agentId: recipient.agentId },
      kind: inputValue.kind ?? "delegate" as const,
      priority: inputValue.priority ?? "normal" as const,
      idempotencyKey,
      createdAt,
      summary: inputValue.summary,
      ...(normalizeDetails(inputValue.details) ? { details: normalizeDetails(inputValue.details) } : {}),
      ...(inputValue.replyToMessageId ? { replyToMessageId: inputValue.replyToMessageId } : {}),
      ...(inputValue.supersedesMessageId ? { supersedesMessageId: inputValue.supersedesMessageId } : {}),
      ...(inputValue.progressFingerprint && inputValue.progressKind ? { progressFingerprint: inputValue.progressFingerprint, progressKind: inputValue.progressKind } : {}),
      replyDepth: inputValue.replyDepth ?? 0,
    };
    const replyDepth = Math.max(inputValue.replyDepth ?? 0, replyParent ? replyParent.replyDepth + 1 : 0);
    if (replyDepth > MAX_AGENT_REPLY_DEPTH) return { ok: false, error: `A2A exchange reached M9R's bounded reply depth (${MAX_AGENT_REPLY_DEPTH}).` };
    const result = router.send(parseA2AMessage({ ...raw, replyDepth }));
    if (!result.ok) return result;
    if (taskId) contextFor(taskId, conversationId);
    const receipt = deliveryReceipts.get(result.message.messageId);
    return { ...result, ...(receipt ? { delivery: receipt } : {}) };
  };

  return {
    runId: roster.runId,
    roster,
    send(identity, inputValue) {
      return sendFromHandle(identity.handle, identity.provider, inputValue);
    },
    sendFromHandle,
    applyControl(control) {
      const context = contexts.get(control.taskId);
      if (!context) return { ok: false, error: `No active multiplayer task context exists for ${control.taskId}.` };
      const result = context.applyControl(control);
      return result.ok ? { ok: true, context: result.context } : { ok: false, error: result.error, context: result.context };
    },
    recordProgress(taskId, witness) {
      const context = contexts.get(taskId);
      if (!context) return { ok: false, error: "No active multiplayer task context matches this progress witness." };
      const result = context.recordProgress(witness);
      return result.ok ? { ok: true, context: result.context } : { ok: false, error: result.error, context: result.context };
    },
    snapshot() {
      return { roster, a2a: router.history(), tasks: [...contexts.values()].map((context) => context.snapshot()), run: coordinator.snapshot() };
    },
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    setDelivery(next) { delivery = next; },
  };
}

