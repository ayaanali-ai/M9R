import { createHash, randomUUID } from "node:crypto";
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

/**
 * The owner-broker coordination boundary.  The contracts in the multiplayer
 * modules are deliberately pure; this adapter is the missing live seam that
 * binds them to authenticated provider identities and the durable task path.
 * It never owns provider credentials or desktop input.
 */
export interface MultiplayerDelivery {
  (message: A2AMessage): Promise<{ ok: boolean; taskId?: string; error?: string }> | { ok: boolean; taskId?: string; error?: string };
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
  | { readonly ok: true; readonly duplicate: boolean; readonly message: A2AMessage; readonly recipientAgentIds: readonly string[] }
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
  let delivery = input.delivery;

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

  router.subscribe((event) => {
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
    if (delivery) {
      // Delivery is deliberately detached from contract acceptance. A provider
      // may be busy, but the structured sidecar remains accepted and durable in
      // the runtime until the task path can present it.
      void Promise.resolve(delivery(message)).catch(() => undefined);
    }
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
    const taskId = inputValue.taskId?.trim() || undefined;
    const conversationId = inputValue.conversationId?.trim() || (taskId ? safeId("conversation", taskId) : safeId("conversation", `${sender.agentId}:${recipient.agentId}`));
    const idempotencyKey = inputValue.idempotencyKey?.trim() || safeId("a2a", `${sender.agentId}:${recipient.agentId}:${taskId ?? "room"}:${inputValue.summary}`);
    const raw = {
      schemaVersion: 1 as const,
      runId: roster.runId,
      branchId: sender.branchId,
      agentId: sender.agentId,
      ...(taskId ? { taskId } : {}),
      conversationId,
      // A caller-supplied idempotency key is the retry identity. Reusing the
      // derived message ID lets the router treat a lost response as a true
      // duplicate instead of mistaking it for conflicting content.
      messageId: inputValue.idempotencyKey ? safeId("message", `${sender.agentId}:${idempotencyKey}`) : randomUUID(),
      recipient: { kind: "agent" as const, agentId: recipient.agentId },
      kind: inputValue.kind ?? "delegate" as const,
      priority: inputValue.priority ?? "normal" as const,
      idempotencyKey,
      createdAt: now(),
      summary: inputValue.summary,
      ...(normalizeDetails(inputValue.details) ? { details: normalizeDetails(inputValue.details) } : {}),
      ...(inputValue.replyToMessageId ? { replyToMessageId: inputValue.replyToMessageId } : {}),
      ...(inputValue.supersedesMessageId ? { supersedesMessageId: inputValue.supersedesMessageId } : {}),
      ...(inputValue.progressFingerprint && inputValue.progressKind ? { progressFingerprint: inputValue.progressFingerprint, progressKind: inputValue.progressKind } : {}),
      replyDepth: inputValue.replyDepth ?? 0,
    };
    const result = router.send(parseA2AMessage(raw));
    if (!result.ok) return result;
    if (taskId) contextFor(taskId, conversationId);
    return result;
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

