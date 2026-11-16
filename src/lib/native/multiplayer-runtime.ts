import { createHash } from "node:crypto";
import {
  createMultiplayerA2ARouter,
  type A2AMessageReference,
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
  type TaskAssignment,
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
import { redactSecrets } from "./inbox-core";

/**
 * The owner-broker coordination boundary.  The contracts in the multiplayer
 * modules are deliberately pure; this adapter is the missing live seam that
 * binds them to authenticated provider identities and the durable task path.
 * It never owns provider credentials or desktop input.
 */
export interface MultiplayerDelivery {
  (message: A2AMessage, context?: TaskContext): Promise<{ ok: boolean; taskId?: string; created?: boolean; state?: "queued" | "already-present" | "pending" | "uncertain" | "completed"; error?: string }> | { ok: boolean; taskId?: string; created?: boolean; state?: "queued" | "already-present" | "pending" | "uncertain" | "completed"; error?: string };
}

type MultiplayerDeliveryOutcome = { ok: boolean; taskId?: string; created?: boolean; state?: "queued" | "already-present" | "pending" | "uncertain" | "completed"; error?: string };

export type MultiplayerDeliveryReceipt = {
  readonly state: "queued" | "already-present" | "pending" | "uncertain" | "completed" | "held-no-progress" | "not-configured" | "failed";
  /** The actual durable recipient inbox task, when one was created. */
  readonly taskId?: string;
  /** False when an idempotent retry resolved to the existing durable task. */
  readonly created?: boolean;
  readonly error?: string;
};

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
}

export interface MultiplayerA2APriorMessage {
  readonly messageId: string;
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly progressFingerprint?: string;
  readonly progressKind?: A2AProgressKind;
  readonly summary: string;
  readonly createdAt: number;
}

export interface MultiplayerRuntimeSnapshot {
  readonly roster: MultiplayerRoster;
  readonly a2a: readonly A2AMessage[];
  readonly tasks: readonly TaskContext[];
  readonly run: ReturnType<RunCoordinator["snapshot"]>;
}

export type MultiplayerSendResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly message: A2AMessage; readonly recipientAgentIds: readonly string[]; readonly delivery: MultiplayerDeliveryReceipt }
  | { readonly ok: false; readonly error: string };

export interface MultiplayerRuntime {
  readonly runId: string;
  readonly roster: MultiplayerRoster;
  send(identity: VerifiedIdentity, input: MultiplayerA2ASendInput): MultiplayerSendResult;
  sendFromHandle(senderHandle: string, senderProvider: string, input: MultiplayerA2ASendInput): MultiplayerSendResult;
  applyControl(control: TaskControl): { ok: boolean; error?: string; context?: TaskContext };
  recordProgress(taskId: string, witness: TaskProgressWitness): { ok: boolean; error?: string; context?: TaskContext };
  readTaskContext(identity: VerifiedIdentity, taskId: string): { ok: boolean; error?: string; context?: TaskContext };
  claimWork(identity: VerifiedIdentity, input: { taskId: string; assignmentId: string; workKey: string; summary: string }): { ok: boolean; error?: string; duplicate?: boolean; context?: TaskContext };
  completeWork(identity: VerifiedIdentity, taskId: string, assignmentId: string): { ok: boolean; error?: string; duplicate?: boolean; context?: TaskContext };
  releaseWork(identity: VerifiedIdentity, taskId: string, assignmentId: string): { ok: boolean; error?: string; duplicate?: boolean; context?: TaskContext };
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

function storedProgressFingerprint(value: string): string {
  // Pre-hashing builds stored caller-supplied fingerprints directly. Preserve
  // already-hashed values while migrating those older values on read.
  return /^progress-[0-9a-f]{24}$/i.test(value) ? value : safeId("progress", value);
}

function participants(roster: MultiplayerRoster): TaskParticipant[] {
  return roster.agents.map((agent) => ({ agentId: agent.agentId, branchId: agent.branchId, provider: agent.provider }));
}

function normalizeDetails(details: MultiplayerA2ASendInput["details"]): MultiplayerA2ASendInput["details"] | undefined {
  if (!details) return undefined;
  const entries = Object.entries(details).slice(0, 32).map(([key, value]) => [
    key.slice(0, 128),
    typeof value === "string" ? redactSecrets(value).slice(0, 2_000) : value,
  ] as const);
  const normalized = Object.fromEntries(entries);
  if (JSON.stringify(normalized).length > 4_000) throw new Error("Structured teammate details exceed the 4000-character durable-message limit.");
  return normalized;
}

export function createMultiplayerRuntime(input: {
  roster: MultiplayerRoster;
  now?: () => number;
  delivery?: MultiplayerDelivery;
  knownMessageIds?: readonly string[];
  knownMessages?: readonly A2AMessage[];
  knownMessageReferences?: readonly A2AMessageReference[];
  priorMessages?: readonly MultiplayerA2APriorMessage[];
  initialTaskContexts?: readonly TaskContext[];
  persistTaskContext?: (context: TaskContext) => void;
}): MultiplayerRuntime {
  const now = input.now ?? Date.now;
  const roster = input.roster;
  const byHandle = new Map(roster.agents.map((agent) => [safeHandle(agent.handle ?? agent.agentId), agent]));
  const router: MultiplayerA2ARouter = createMultiplayerA2ARouter(roster, {
    now,
    knownMessageIds: input.knownMessageIds,
    knownMessages: input.knownMessages,
    knownMessageReferences: input.knownMessageReferences,
  });
  const coordinator = createMultiplayerRunCoordinator(roster, { now });
  const contexts = new Map<string, TaskContextStore>();
  const subscribers = new Set<(message: A2AMessage) => void>();
  const deliveries = new Map<string, MultiplayerDeliveryReceipt>();
  const initialContexts = new Map((input.initialTaskContexts ?? []).map((context) => [context.taskId, context]));
  const contextPersistenceErrors = new Map<string, string>();
  let delivery = input.delivery;

  const contextFor = (taskId: string, conversationId: string): TaskContextStore => {
    const existing = contexts.get(taskId);
    if (existing) {
      if (existing.snapshot().conversationId !== conversationId) throw new Error("The shared task is already bound to a different conversation.");
      return existing;
    }
    const initial = initialContexts.get(taskId);
    const initialProgress = initial?.progress.lastWitness;
    const normalizedInitial = initial && initialProgress
      ? {
          ...initial,
          progress: {
            ...initial.progress,
            lastWitness: {
              ...initialProgress,
              stateFingerprint: storedProgressFingerprint(initialProgress.stateFingerprint),
            },
          },
        }
      : initial;
    const created = createTaskContext({
      taskId,
      conversationId,
      runId: roster.runId,
      participants: participants(roster),
      ...(normalizedInitial ? { initial: normalizedInitial } : {}),
      now: now(),
    });
    contexts.set(taskId, created);
    return created;
  };

  const persistContext = (taskId: string, context: TaskContextStore): boolean => {
    if (!input.persistTaskContext) return true;
    try {
      input.persistTaskContext(context.snapshot());
      contextPersistenceErrors.delete(taskId);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      contextPersistenceErrors.set(taskId, detail);
      return false;
    }
  };

  const contextPersistenceError = (taskId: string): string =>
    `M9R could not durably save shared task state for ${taskId}; no new provider turn was queued. ${contextPersistenceErrors.get(taskId) ?? "Retry the same operation after resolving the local store error."}`;

  for (const initial of initialContexts.values()) contextFor(initial.taskId, initial.conversationId);

  // Rebuild only the compact progress witnesses needed for loop convergence.
  // Full prose remains in the durable inbox task, while references survive a
  // broker restart so a provider can reply in the same conversation.
  for (const prior of input.priorMessages ?? []) {
    if (!prior.taskId || !prior.progressFingerprint || !prior.progressKind || !Number.isFinite(prior.createdAt)) continue;
    if (initialContexts.has(prior.taskId)) continue;
    const conversationId = prior.conversationId ?? safeId("conversation", prior.taskId);
    contextFor(prior.taskId, conversationId).recordProgress({
      witnessId: prior.messageId,
      kind: prior.progressKind,
      stateFingerprint: storedProgressFingerprint(prior.progressFingerprint),
      summary: prior.summary.slice(0, 280) || "Prior team progress witness.",
      at: prior.createdAt,
    });
  }
  router.subscribe((event) => {
    if (event.kind !== "message-accepted") return;
    const message = event.message;
    if (message.taskId) {
      const task = contextFor(message.taskId, message.conversationId ?? safeId("conversation", message.taskId));
      if (message.progressFingerprint && message.progressKind) {
        const result = task.recordProgress({
          witnessId: message.messageId,
          kind: message.progressKind,
          stateFingerprint: message.progressFingerprint,
          summary: message.summary,
          at: message.createdAt,
        });
        if (!result.ok) {
          contextPersistenceErrors.set(message.taskId, result.error);
          return;
        }
      }
      if (!persistContext(message.taskId, task)) return;
    }
    for (const listener of subscribers) {
      try { listener(message); } catch { /* observers never own delivery */ }
    }
  });

  const enqueueForRecipient = (message: A2AMessage): MultiplayerDeliveryReceipt => {
    const existing = deliveries.get(message.messageId);
    if (existing && existing.state !== "failed") return existing;
    if (!delivery) return { state: "not-configured" };

    const context = message.taskId ? contexts.get(message.taskId)?.snapshot() : undefined;
    if (context?.state === "waiting-agent" && message.kind !== "blocker" && message.kind !== "stop" && message.kind !== "supersede") {
      const held = {
        state: "held-no-progress" as const,
        error: "No new task progress was recorded. The message remains in the conversation, but M9R did not wake another provider turn. Send a new progress witness or request clarification to continue.",
      };
      deliveries.set(message.messageId, held);
      return held;
    }

    try {
      const result = delivery(message, context);
      if (result && typeof result === "object" && "then" in result && typeof (result as { then?: unknown }).then === "function") {
        const pending = { state: "pending" as const };
        deliveries.set(message.messageId, pending);
        void Promise.resolve(result as PromiseLike<MultiplayerDeliveryOutcome>).then((resolved) => {
          deliveries.set(message.messageId, resolved.ok
            ? { state: resolved.state ?? "queued", ...(resolved.taskId ? { taskId: resolved.taskId } : {}), ...(resolved.created === undefined ? {} : { created: resolved.created }) }
            : { state: "failed", ...(resolved.error ? { error: resolved.error } : { error: "The recipient inbox did not accept the message." }) });
        }).catch((error: unknown) => {
          deliveries.set(message.messageId, { state: "failed", error: error instanceof Error ? error.message : String(error) });
          process.stderr.write(`[multiplayer-runtime] delivery of message ${message.messageId} failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
        return pending;
      }
      const resolved = result as MultiplayerDeliveryOutcome;
      const receipt: MultiplayerDeliveryReceipt = resolved.ok
        ? { state: resolved.state ?? "queued", ...(resolved.taskId ? { taskId: resolved.taskId } : {}), ...(resolved.created === undefined ? {} : { created: resolved.created }) }
        : { state: resolved.state === "uncertain" ? "uncertain" : "failed", ...(resolved.error ? { error: resolved.error } : { error: "The recipient inbox did not accept the message." }) };
      deliveries.set(message.messageId, receipt);
      return receipt;
    } catch (error) {
      const receipt = { state: "failed" as const, error: error instanceof Error ? error.message : String(error) };
      deliveries.set(message.messageId, receipt);
      process.stderr.write(`[multiplayer-runtime] delivery of message ${message.messageId} failed: ${receipt.error}\n`);
      return receipt;
    }
  };

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
    const parentReference = inputValue.replyToMessageId ? router.referenceFor(inputValue.replyToMessageId) : undefined;
    // Each agent only knows its own private per-recipient task id (M9R creates
    // one inbox task per recipient from a single owner broadcast; there is no
    // shared "room id" exposed to the model). A reply must stay bound to the
    // task/conversation the thread was actually opened under -- the parent
    // message's values -- never the replier's own, structurally different,
    // task id, even if the caller happens to pass one. Only a thread's first
    // message (no parent) gets to establish that shared value.
    const taskId = parentReference?.taskId ?? inputValue.taskId?.trim();
    // New conversations must be task-scoped. Continue a previously durable
    // taskless thread only when the caller names its exact stored parent; the
    // existing depth and message bounds still apply to those legacy replies.
    if (!taskId && !parentReference) return { ok: false, error: "A structured teammate conversation must belong to a shared task. Use m9r_send for a separate delegated task." };
    const kind = inputValue.kind ?? "delegate";
    const actionableKinds = new Set<A2AMessageKind>(["help-request", "help-result", "delegate", "blocker", "surface-handoff", "edit-confirmation", "verification-request"]);
    if (taskId && actionableKinds.has(kind) && (!inputValue.progressFingerprint || !inputValue.progressKind)) {
      return { ok: false, error: "A task-bound teammate message needs a progressFingerprint and progressKind so repeated no-progress turns can be held safely." };
    }
    const summary = redactSecrets(inputValue.summary.trim()).slice(0, 280);
    if (!summary) return { ok: false, error: "A structured teammate message needs non-empty text after secret redaction." };
    let details: MultiplayerA2ASendInput["details"];
    try { details = normalizeDetails(inputValue.details); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Structured teammate details are invalid." }; }
    const conversationId = parentReference?.conversationId
      ?? (inputValue.conversationId?.trim() || (taskId ? safeId("conversation", taskId) : undefined));
    const replyDepth = parentReference ? parentReference.replyDepth + 1 : 0;
    const progressFingerprint = inputValue.progressFingerprint ? storedProgressFingerprint(inputValue.progressFingerprint) : undefined;
    const canonicalDetails = details
      ? Object.fromEntries(Object.keys(details).sort().map((key) => [key, details![key]]))
      : undefined;
    const retryIdentity = inputValue.idempotencyKey?.trim() || JSON.stringify({
      senderAgentId: sender.agentId,
      recipientAgentId: recipient.agentId,
      taskId,
      conversationId,
      kind,
      priority: inputValue.priority ?? "normal",
      summary,
      details: canonicalDetails,
      replyToMessageId: inputValue.replyToMessageId,
      supersedesMessageId: inputValue.supersedesMessageId,
      progressFingerprint,
      progressKind: inputValue.progressKind,
    });
    const idempotencyKey = safeId("a2a", `${sender.agentId}:${retryIdentity}`);
    const raw = {
      schemaVersion: 1 as const,
      runId: roster.runId,
      branchId: sender.branchId,
      agentId: sender.agentId,
      ...(taskId ? { taskId } : {}),
      ...(conversationId ? { conversationId } : {}),
      // Every send has a stable message ID, including sends whose tool call
      // omitted an explicit idempotency key. That lets a retry after a lost
      // broker response resolve to the original durable peer-inbox task.
      messageId: safeId("message", `${sender.agentId}:${idempotencyKey}`),
      recipient: { kind: "agent" as const, agentId: recipient.agentId },
      kind,
      priority: inputValue.priority ?? "normal" as const,
      idempotencyKey,
      createdAt: now(),
      summary,
      ...(details ? { details } : {}),
      ...(inputValue.replyToMessageId ? { replyToMessageId: inputValue.replyToMessageId } : {}),
      ...(inputValue.supersedesMessageId ? { supersedesMessageId: inputValue.supersedesMessageId } : {}),
      ...(progressFingerprint && inputValue.progressKind ? { progressFingerprint, progressKind: inputValue.progressKind } : {}),
      replyDepth,
    };
    let contextStore: TaskContextStore | undefined;
    if (taskId) {
      try {
        contextStore = contextFor(taskId, conversationId ?? safeId("conversation", taskId));
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "M9R could not restore the shared task state." };
      }
    }
    if (contextStore && ["completed", "canceled"].includes(contextStore.snapshot().state) && kind !== "stop" && kind !== "supersede") {
      return { ok: false, error: "This shared task is already terminal; start a new owner task instead of waking another provider turn." };
    }
    const result = router.send(parseA2AMessage(raw));
    if (!result.ok) return result;
    if (taskId && contextStore && !persistContext(taskId, contextStore)) return { ok: false, error: contextPersistenceError(taskId) };
    const receipt = enqueueForRecipient(result.message);
    return { ...result, delivery: receipt };
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
      if (!result.ok) return { ok: false, error: result.error, context: result.context };
      if (!persistContext(control.taskId, context)) return { ok: false, error: contextPersistenceError(control.taskId), context: result.context };
      return { ok: true, context: result.context };
    },
    recordProgress(taskId, witness) {
      const context = contexts.get(taskId);
      if (!context) return { ok: false, error: "No active multiplayer task context matches this progress witness." };
      const result = context.recordProgress(witness);
      if (!result.ok) return { ok: false, error: result.error, context: result.context };
      if (!persistContext(taskId, context)) return { ok: false, error: contextPersistenceError(taskId), context: result.context };
      return { ok: true, context: result.context };
    },
    readTaskContext(identity, taskId) {
      const sender = resolveSender(identity.handle, identity.provider);
      const context = contexts.get(taskId);
      if (!sender || !context || !context.snapshot().participants.some((participant) => participant.agentId === sender.agentId)) {
        return { ok: false, error: `No shared task state is available to this agent for ${taskId}.` };
      }
      return { ok: true, context: context.snapshot() };
    },
    claimWork(identity, request) {
      const sender = resolveSender(identity.handle, identity.provider);
      const context = contexts.get(request.taskId);
      if (!sender || !context || !context.snapshot().participants.some((participant) => participant.agentId === sender.agentId)) {
        return { ok: false, error: `No shared task state is available to this agent for ${request.taskId}.` };
      }
      const snapshot = context.snapshot();
      if (snapshot.state !== "active") return { ok: false, error: `Shared task ${request.taskId} is ${snapshot.state}; no new work can be claimed until it becomes active.` };
      const assignment: TaskAssignment = {
        assignmentId: request.assignmentId,
        workKey: request.workKey,
        agentId: sender.agentId,
        planRevision: snapshot.planRevision,
        status: "claimed",
        summary: redactSecrets(request.summary.trim()).slice(0, 280),
        updatedAt: Math.max(snapshot.updatedAt, now()),
      };
      const result = context.claimAssignment(assignment);
      if (!result.ok) return { ok: false, error: result.error, context: result.context };
      if (!persistContext(request.taskId, context)) return { ok: false, error: contextPersistenceError(request.taskId), context: result.context };
      return { ok: true, duplicate: result.duplicate, context: result.context };
    },
    completeWork(identity, taskId, assignmentId) {
      const sender = resolveSender(identity.handle, identity.provider);
      const context = contexts.get(taskId);
      const assignment = context?.snapshot().assignments.find((item) => item.assignmentId === assignmentId);
      if (!sender || !context || !assignment || assignment.agentId !== sender.agentId) {
        return { ok: false, error: "This shared-work assignment is not owned by this agent." };
      }
      if (["completed", "canceled"].includes(context.snapshot().state) && assignment.status !== "completed") {
        return { ok: false, error: "A terminal shared task cannot complete an unfinished assignment." };
      }
      const result = context.completeAssignment(assignmentId, now());
      if (!result.ok) return { ok: false, error: result.error, context: result.context };
      if (!persistContext(taskId, context)) return { ok: false, error: contextPersistenceError(taskId), context: result.context };
      return { ok: true, duplicate: result.duplicate, context: result.context };
    },
    releaseWork(identity, taskId, assignmentId) {
      const sender = resolveSender(identity.handle, identity.provider);
      const context = contexts.get(taskId);
      const assignment = context?.snapshot().assignments.find((item) => item.assignmentId === assignmentId);
      if (!sender || !context || !assignment || assignment.agentId !== sender.agentId) {
        return { ok: false, error: "This shared-work assignment is not owned by this agent." };
      }
      if (assignment.status === "completed") return { ok: false, error: "Completed shared work cannot be released." };
      if (["completed", "canceled"].includes(context.snapshot().state) && assignment.status !== "released") {
        return { ok: false, error: "A terminal shared task cannot release an active assignment." };
      }
      const prior = assignment.status;
      const snapshot = context.releaseAssignment(assignmentId, now());
      if (!persistContext(taskId, context)) return { ok: false, error: contextPersistenceError(taskId), context: snapshot };
      return { ok: true, duplicate: prior === "released", context: snapshot };
    },
    snapshot() {
      return { roster, a2a: router.history(), tasks: [...contexts.values()].map((context) => context.snapshot()), run: coordinator.snapshot() };
    },
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    setDelivery(next) { delivery = next; },
  };
}

