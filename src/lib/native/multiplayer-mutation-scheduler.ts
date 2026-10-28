import { randomUUID } from "node:crypto";
import {
  parseMultiplayerLease,
  parseMultiplayerOperation,
  type MultiplayerLease,
  type MultiplayerOperation,
  type MultiplayerRoster,
} from "./multiplayer-contract";
import {
  createTargetIdentityRegistry,
  type MultiplayerTargetBinding,
  type TargetIdentityRegistry,
} from "./multiplayer-target-identity";

export type MutationReceiptStatus = "claimed" | "committed" | "aborted" | "conflict" | "stale" | "expired";
export type MutationRejectionCode = "invalid" | "lease-unavailable" | "stale-revision" | "operation-conflict" | "target-identity-conflict" | "already-terminal";
export type MutationRetryAction = "wait" | "rebase" | "new-operation-id" | "inspect-receipt" | "never";

export interface MutationReceipt {
  readonly operationId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly agentId: string;
  readonly surfaceId: string;
  readonly regionId?: string;
  readonly leaseId?: string;
  readonly status: MutationReceiptStatus;
  readonly baseSurfaceRevision: number;
  readonly baseSurfaceMutationRevision?: number;
  readonly baseRegionRevision?: number;
  readonly resultingSurfaceRevision?: number;
  readonly resultingSurfaceMutationRevision?: number;
  readonly resultingRegionRevision?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly conflictWithOperationId?: string;
  readonly detail?: string;
}

export interface MutationIntent {
  readonly operation: MultiplayerOperation;
  /**
   * Optional Phase 7 target binding. Existing callers may omit it while they
   * remain on an explicit legacy path; multiplayer callers pass it to make a
   * tab/window identity mandatory before a mutation lease is acquired.
   */
  readonly targetBinding?: MultiplayerTargetBinding;
  /** The latest surface epoch observed by the agent. Operation.revision carries this value too. */
  readonly expectedSurfaceRevision?: number;
  /** Required for surface-wide mutations; changes after any committed edit. */
  readonly expectedSurfaceMutationRevision?: number;
  /** Required for region edits; independent regions maintain independent revisions. */
  readonly expectedRegionRevision?: number;
  /** Optional external stop signal; aborting it releases this short transaction. */
  readonly signal?: AbortSignal;
}

export interface MutationTransaction {
  readonly operation: MultiplayerOperation;
  readonly lease: MultiplayerLease;
  readonly signal: AbortSignal;
  readonly receipt: MutationReceipt;
  commit(): MutationCommitResult;
  abort(reason?: string): MutationAbortResult;
}

export type MutationBeginResult =
  | { readonly ok: true; readonly duplicate: false; readonly transaction: MutationTransaction }
  | { readonly ok: true; readonly duplicate: true; readonly receipt: MutationReceipt }
  | { readonly ok: false; readonly code: MutationRejectionCode; readonly error: string; readonly retry: MutationRetryDecision; readonly receipt?: MutationReceipt };

export type MutationCommitResult =
  | { readonly ok: true; readonly receipt: MutationReceipt }
  | { readonly ok: false; readonly code: "aborted" | "expired" | "stale-revision" | "not-found"; readonly error: string; readonly retry: MutationRetryDecision; readonly receipt: MutationReceipt };

export type MutationAbortResult =
  | { readonly ok: true; readonly receipt: MutationReceipt }
  | { readonly ok: false; readonly code: "not-found" | "already-terminal"; readonly error: string; readonly receipt?: MutationReceipt };

export interface MutationRetryDecision {
  readonly action: MutationRetryAction;
  readonly reason: string;
  readonly operationId?: string;
  readonly surfaceRevision?: number;
  readonly regionRevision?: number;
  readonly surfaceMutationRevision?: number;
}

export interface MutationSchedulerSnapshot {
  readonly activeLeases: readonly MultiplayerLease[];
  readonly receipts: readonly MutationReceipt[];
  readonly surfaceRevisions: Readonly<Record<string, number>>;
  readonly surfaceMutationRevisions: Readonly<Record<string, number>>;
  readonly regionRevisions: Readonly<Record<string, number>>;
}

export interface MutationLeaseScope {
  readonly surfaceId: string;
  readonly regionId?: string;
}

export interface MultiplayerMutationScheduler {
  begin(intent: MutationIntent): MutationBeginResult;
  commit(operationId: string): MutationCommitResult;
  abort(operationId: string, reason?: string): MutationAbortResult;
  receipt(operationId: string): MutationReceipt | undefined;
  sweepExpired(): readonly MutationReceipt[];
  snapshot(): MutationSchedulerSnapshot;
  /** Subscribe to lease/revision changes; callers can react without polling. */
  subscribe(listener: () => void): () => void;
  /** Resolve when an overlapping lease is gone or expires, using notifications rather than a polling loop. */
  waitForAvailability(scope: MutationLeaseScope, signal?: AbortSignal): Promise<void>;
}

export interface MutationSchedulerOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly leaseTtlMs?: number;
  readonly maxReceipts?: number;
  readonly initialSurfaceRevision?: number;
  /** Injected for a run coordinator; a private registry is used otherwise. */
  readonly targetRegistry?: TargetIdentityRegistry;
}

type ActiveTransaction = {
  readonly intent: MutationIntent;
  readonly operation: MultiplayerOperation;
  readonly lease: MultiplayerLease;
  readonly controller: AbortController;
  readonly fingerprint: string;
  readonly baseSurfaceRevision: number;
  readonly baseSurfaceMutationRevision?: number;
  readonly baseRegionRevision?: number;
};

type MutableReceipt = MutationReceipt;
type MutationOperationShape = Pick<MultiplayerOperation, "surfaceId" | "regionId">;

function scopeKey(surfaceId: string, regionId?: string): string {
  return regionId === undefined ? `surface:${surfaceId}` : `region:${surfaceId}:${regionId}`;
}

function conflicts(left: ActiveTransaction, right: MutationOperationShape): boolean {
  if (left.operation.surfaceId !== right.surfaceId) return false;
  if (left.operation.regionId === undefined || right.regionId === undefined) return true;
  return left.operation.regionId === right.regionId;
}

function fingerprint(intent: MutationIntent): string {
  return JSON.stringify({ operation: intent.operation, targetBinding: intent.targetBinding, expectedSurfaceMutationRevision: intent.expectedSurfaceMutationRevision, expectedRegionRevision: intent.expectedRegionRevision });
}

function safeDetail(value: string | undefined, fallback: string): string {
  const clean = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return (clean || fallback).slice(0, 240);
}

/**
 * One in-memory mutation fence for a multiplayer run. It arbitrates leases
 * and revisions; it does not dispatch browser/desktop input. A caller holds a
 * short transaction, performs the existing route action, then commits or
 * aborts the operation receipt.
 */
export function createMultiplayerMutationScheduler(
  roster: MultiplayerRoster,
  options: MutationSchedulerOptions = {},
): MultiplayerMutationScheduler {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const leaseTtlMs = options.leaseTtlMs ?? 15_000;
  const maxReceipts = options.maxReceipts ?? 4096;
  const initialSurfaceRevision = options.initialSurfaceRevision ?? 0;
  const targetRegistry = options.targetRegistry ?? createTargetIdentityRegistry();
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 100 || leaseTtlMs > 10 * 60_000) throw new Error("Mutation lease TTL is invalid.");
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 16_384) throw new Error("Mutation receipt bound is invalid.");
  if (!Number.isSafeInteger(initialSurfaceRevision) || initialSurfaceRevision < 0) throw new Error("Initial surface revision is invalid.");

  const agents = new Map(roster.agents.map((agent) => [agent.agentId, agent]));
  const active = new Map<string, ActiveTransaction>();
  const receipts = new Map<string, MutableReceipt>();
  const receiptOrder: string[] = [];
  const surfaceRevisions = new Map<string, number>();
  const regionRevisions = new Map<string, number>();
  const surfaceMutationRevisions = new Map<string, number>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* observers never own the mutation fence */ }
    }
  };
  const hasConflict = (scope: MutationLeaseScope): boolean => [...active.values()].some((candidate) => conflicts(candidate, scope));

  const currentSurfaceRevision = (surfaceId: string): number => surfaceRevisions.get(surfaceId) ?? initialSurfaceRevision;
  const currentRegionRevision = (surfaceId: string, regionId: string): number => regionRevisions.get(scopeKey(surfaceId, regionId)) ?? 0;
  const currentSurfaceMutationRevision = (surfaceId: string): number => surfaceMutationRevisions.get(surfaceId) ?? 0;
  const addReceipt = (receipt: MutationReceipt): void => {
    receipts.set(receipt.operationId, receipt);
    if (!receiptOrder.includes(receipt.operationId)) receiptOrder.push(receipt.operationId);
    while (receiptOrder.length > maxReceipts) {
      const removed = receiptOrder.shift();
      if (removed) receipts.delete(removed);
    }
  };
  const replaceReceipt = (receipt: MutationReceipt): MutationReceipt => { addReceipt(receipt); return receipt; };

  const releaseActive = (operationId: string, abortSignal = true): ActiveTransaction | undefined => {
    const transaction = active.get(operationId);
    if (!transaction) return undefined;
    active.delete(operationId);
    if (abortSignal) transaction.controller.abort();
    return transaction;
  };

  const scheduler: MultiplayerMutationScheduler = {
    begin(intent) {
      scheduler.sweepExpired();
      let operation: MultiplayerOperation;
      try { operation = parseMultiplayerOperation(intent.operation); }
      catch (error) {
        return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid mutation operation.", retry: { action: "never", reason: "The operation failed contract validation." } };
      }
      if (operation.kind !== "mutate") return { ok: false, code: "invalid", error: "Only mutate operations may acquire a multiplayer mutation lease.", retry: { action: "never", reason: "Observe, prepare, verify, and handoff operations do not mutate a surface." } };
      const agent = agents.get(operation.agentId);
      if (!agent || agent.branchId !== operation.branchId) return { ok: false, code: "invalid", error: "Mutation agent/branch is not in this run roster.", retry: { action: "never", reason: "The operation identity does not match the run roster." } };
      if (intent.targetBinding) {
        const target = intent.targetBinding;
        if (target.runId !== operation.runId || target.branchId !== operation.branchId || target.agentId !== operation.agentId || target.surfaceId !== operation.surfaceId) {
          return { ok: false, code: "invalid", error: "Mutation target identity does not match the operation correlation.", retry: { action: "never", reason: "A target can only be mutated by the correlated run, branch, agent, and surface." } };
        }
      }
      const expectedSurfaceRevision = intent.expectedSurfaceRevision ?? operation.revision;
      if (!Number.isSafeInteger(expectedSurfaceRevision) || expectedSurfaceRevision < 0 || expectedSurfaceRevision !== operation.revision) {
        return { ok: false, code: "invalid", error: "Mutation surface revision must be a nonnegative integer matching operation.revision.", retry: { action: "never", reason: "The operation revision is not a valid surface epoch." } };
      }
      if (operation.regionId === undefined && intent.expectedRegionRevision !== undefined) {
        return { ok: false, code: "invalid", error: "A surface-wide mutation cannot carry a region revision.", retry: { action: "never", reason: "Surface-wide edits use only the surface revision." } };
      }
      if (operation.regionId === undefined && !Number.isSafeInteger(intent.expectedSurfaceMutationRevision)) {
        return { ok: false, code: "invalid", error: "A surface-wide mutation requires expectedSurfaceMutationRevision.", retry: { action: "never", reason: "Whole-surface edits must fence against every committed mutation." } };
      }
      if (operation.regionId !== undefined && (!Number.isSafeInteger(intent.expectedRegionRevision) || (intent.expectedRegionRevision ?? -1) < 0)) {
        return { ok: false, code: "invalid", error: "A region mutation requires a nonnegative expectedRegionRevision.", retry: { action: "never", reason: "Region edits need an independent region fence." } };
      }

      const existing = receipts.get(operation.operationId);
      const operationFingerprint = fingerprint({ ...intent, operation });
      if (existing) {
        const running = active.get(operation.operationId);
        if (running) {
          if (running.fingerprint !== operationFingerprint) return { ok: false, code: "operation-conflict", error: "This operation ID is already leased for different mutation content.", retry: { action: "new-operation-id", reason: "Use a new operation ID for different input." } };
          return { ok: true, duplicate: true, receipt: existing };
        }
        return existing.status === "claimed"
          ? { ok: true, duplicate: true, receipt: existing }
          : { ok: false, code: "already-terminal", error: `Operation ${operation.operationId} already has a ${existing.status} receipt.`, retry: { action: "inspect-receipt", reason: "A terminal mutation is never replayed automatically.", operationId: operation.operationId }, receipt: existing };
      }

      const surfaceRevision = currentSurfaceRevision(operation.surfaceId);
      const surfaceMutationRevision = currentSurfaceMutationRevision(operation.surfaceId);
      const regionRevision = operation.regionId === undefined ? undefined : currentRegionRevision(operation.surfaceId, operation.regionId);
      if (surfaceRevision !== expectedSurfaceRevision || (operation.regionId !== undefined && regionRevision !== intent.expectedRegionRevision)
        || (operation.regionId === undefined && surfaceMutationRevision !== intent.expectedSurfaceMutationRevision)) {
        return { ok: false, code: "stale-revision", error: "The observed surface or region revision is stale; refresh and rebase before mutating.", retry: { action: "rebase", reason: "The target revision no longer matches the mutation plan.", surfaceRevision, ...(regionRevision === undefined ? {} : { regionRevision }), ...(operation.regionId === undefined ? { surfaceMutationRevision } : {}) } };
      }
      const conflict = [...active.values()].find((candidate) => conflicts(candidate, operation));
      if (conflict) {
        return { ok: false, code: "lease-unavailable", error: `An overlapping mutation lease is active for operation ${conflict.operation.operationId}.`, retry: { action: "wait", reason: "An overlapping surface or region lease is active." } };
      }

      if (intent.targetBinding) {
        const targetClaim = targetRegistry.claim(intent.targetBinding, operation.operationId);
        if (!targetClaim.ok) {
          return { ok: false, code: targetClaim.code === "duplicate-target" ? "target-identity-conflict" : "invalid", error: targetClaim.error, retry: { action: targetClaim.code === "duplicate-target" ? "wait" : "never", reason: targetClaim.error } };
        }
      }

      const issuedAt = now();
      const lease = parseMultiplayerLease({
        runId: operation.runId,
        branchId: operation.branchId,
        agentId: operation.agentId,
        leaseId: idFactory(),
        surfaceId: operation.surfaceId,
        ...(operation.regionId === undefined ? {} : { regionId: operation.regionId }),
        operationId: operation.operationId,
        holderAgentId: operation.agentId,
        revision: operation.revision,
        state: "active",
        issuedAt,
        expiresAt: issuedAt + leaseTtlMs,
      });
      const controller = new AbortController();
      const receipt: MutationReceipt = {
        operationId: operation.operationId,
        runId: operation.runId,
        branchId: operation.branchId,
        agentId: operation.agentId,
        surfaceId: operation.surfaceId,
        ...(operation.regionId === undefined ? {} : { regionId: operation.regionId }),
        leaseId: lease.leaseId,
        status: "claimed",
        baseSurfaceRevision: surfaceRevision,
        ...(operation.regionId === undefined ? { baseSurfaceMutationRevision: surfaceMutationRevision } : {}),
        ...(regionRevision === undefined ? {} : { baseRegionRevision: regionRevision }),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      };
      const transaction: ActiveTransaction = { intent, operation, lease, controller, fingerprint: operationFingerprint, baseSurfaceRevision: surfaceRevision, ...(operation.regionId === undefined ? { baseSurfaceMutationRevision: surfaceMutationRevision } : {}), ...(regionRevision === undefined ? {} : { baseRegionRevision: regionRevision }) };
      active.set(operation.operationId, transaction);
      addReceipt(receipt);
      notify();
      if (intent.signal) {
        if (intent.signal.aborted) scheduler.abort(operation.operationId, "Mutation was canceled before dispatch.");
        else intent.signal.addEventListener("abort", () => { scheduler.abort(operation.operationId, "Mutation was canceled by its parent operation."); }, { once: true });
      }
      return { ok: true, duplicate: false, transaction: {
        operation,
        lease,
        signal: controller.signal,
        receipt,
        commit: () => scheduler.commit(operation.operationId),
        abort: (reason) => scheduler.abort(operation.operationId, reason),
      } };
    },

    commit(operationId) {
      const transaction = active.get(operationId);
      const prior = receipts.get(operationId);
      if (!transaction) {
        if (!prior) {
          const receipt: MutationReceipt = { operationId, runId: roster.runId, branchId: "unknown", agentId: "unknown", surfaceId: "unknown", status: "aborted", baseSurfaceRevision: 0, createdAt: now(), updatedAt: now(), detail: "not-found" };
          return { ok: false, code: "not-found", error: "Mutation operation was not found.", retry: { action: "never", reason: "There is no owned mutation transaction for this operation." }, receipt };
        }
        if (prior.status === "committed") return { ok: true, receipt: prior };
        const code = prior.status === "expired" ? "expired" : prior.status === "stale" ? "stale-revision" : "aborted";
        return { ok: false, code, error: `Mutation operation is ${prior.status}; it cannot be committed.`, retry: code === "stale-revision" ? { action: "rebase", reason: "The operation became stale before commit." } : { action: "inspect-receipt", reason: "The terminal receipt is authoritative.", operationId }, receipt: prior };
      }
      const currentTime = now();
      if (currentTime >= transaction.lease.expiresAt || transaction.controller.signal.aborted) {
        releaseActive(operationId);
        targetRegistry.release(operationId);
        const receipt = replaceReceipt({ ...prior!, status: currentTime >= transaction.lease.expiresAt ? "expired" : "aborted", updatedAt: currentTime, detail: currentTime >= transaction.lease.expiresAt ? "Mutation lease expired before commit." : "Mutation was canceled before commit." });
        notify();
        return { ok: false, code: currentTime >= transaction.lease.expiresAt ? "expired" : "aborted", error: receipt.detail!, retry: { action: "new-operation-id", reason: "The short mutation transaction is no longer active." }, receipt };
      }
      const surfaceRevision = currentSurfaceRevision(transaction.operation.surfaceId);
      const surfaceMutationRevision = currentSurfaceMutationRevision(transaction.operation.surfaceId);
      const regionRevision = transaction.operation.regionId === undefined ? undefined : currentRegionRevision(transaction.operation.surfaceId, transaction.operation.regionId);
      if (surfaceRevision !== transaction.baseSurfaceRevision
        || (transaction.operation.regionId === undefined && surfaceMutationRevision !== transaction.baseSurfaceMutationRevision)
        || (regionRevision !== undefined && regionRevision !== transaction.baseRegionRevision)) {
        releaseActive(operationId);
        targetRegistry.release(operationId);
        const receipt = replaceReceipt({ ...prior!, status: "stale", updatedAt: currentTime, detail: "The target revision changed before commit; no mutation receipt was committed." });
        notify();
        return { ok: false, code: "stale-revision", error: receipt.detail!, retry: { action: "rebase", reason: "Refresh the target and create a new operation." }, receipt };
      }
      releaseActive(operationId, false);
      targetRegistry.release(operationId);
      const nextSurfaceRevision = transaction.operation.regionId === undefined ? surfaceRevision + 1 : surfaceRevision;
      const nextRegionRevision = transaction.operation.regionId === undefined ? undefined : (regionRevision ?? 0) + 1;
      if (transaction.operation.regionId === undefined) surfaceRevisions.set(transaction.operation.surfaceId, nextSurfaceRevision);
      else regionRevisions.set(scopeKey(transaction.operation.surfaceId, transaction.operation.regionId), nextRegionRevision!);
      surfaceMutationRevisions.set(transaction.operation.surfaceId, surfaceMutationRevision + 1);
      const receipt = replaceReceipt({ ...prior!, status: "committed", updatedAt: currentTime, resultingSurfaceRevision: nextSurfaceRevision, resultingSurfaceMutationRevision: surfaceMutationRevision + 1, ...(nextRegionRevision === undefined ? {} : { resultingRegionRevision: nextRegionRevision }) });
      notify();
      return { ok: true, receipt };
    },

    abort(operationId, reason = "Mutation was aborted before commit.") {
      const transaction = releaseActive(operationId);
      const prior = receipts.get(operationId);
      if (!transaction) return prior ? { ok: false, code: "already-terminal", error: `Mutation operation is already ${prior.status}.`, receipt: prior } : { ok: false, code: "not-found", error: "Mutation operation was not found." };
      targetRegistry.release(operationId);
      const receipt = replaceReceipt({ ...prior!, status: "aborted", updatedAt: now(), detail: safeDetail(reason, "Mutation was aborted before commit.") });
      notify();
      return { ok: true, receipt };
    },

    receipt(operationId) { return receipts.get(operationId); },

    sweepExpired() {
      const expired: MutationReceipt[] = [];
      const currentTime = now();
      for (const [operationId, transaction] of active) {
        if (currentTime < transaction.lease.expiresAt) continue;
        releaseActive(operationId);
        targetRegistry.release(operationId);
        expired.push(replaceReceipt({ ...receipts.get(operationId)!, status: "expired", updatedAt: currentTime, detail: "Mutation lease expired before commit." }));
      }
      if (expired.length > 0) notify();
      return expired;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    waitForAvailability(scope, signal) {
      if (!scope.surfaceId.trim()) return Promise.reject(new Error("Mutation lease scope requires a surface ID."));
      if (!hasConflict(scope)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;
        const cleanup = (): void => {
          if (timer) clearTimeout(timer);
          unsubscribe?.();
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => { cleanup(); reject(new Error("Mutation lease wait was canceled.")); };
        const wake = (): void => {
          if (timer) { clearTimeout(timer); timer = undefined; }
          scheduler.sweepExpired();
          if (hasConflict(scope)) {
            const soonest = [...active.values()]
              .filter((candidate) => conflicts(candidate, scope))
              .reduce((earliest, candidate) => Math.min(earliest, candidate.lease.expiresAt), Number.POSITIVE_INFINITY);
            if (Number.isFinite(soonest)) timer = setTimeout(wake, Math.max(1, soonest - now()));
            return;
          }
          cleanup();
          resolve();
        };
        if (signal?.aborted) { onAbort(); return; }
        unsubscribe = scheduler.subscribe(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
        wake();
      });
    },

    snapshot() {
      scheduler.sweepExpired();
      const activeLeases = [...active.values()].map((transaction) => transaction.lease);
      return {
        activeLeases,
        receipts: receiptOrder.map((operationId) => receipts.get(operationId)).filter((receipt): receipt is MutationReceipt => Boolean(receipt)),
        surfaceRevisions: Object.fromEntries(surfaceRevisions),
        surfaceMutationRevisions: Object.fromEntries(surfaceMutationRevisions),
        regionRevisions: Object.fromEntries(regionRevisions),
      };
    },
  };

  return scheduler;
}
