import { createHash } from "node:crypto";
import type { ComputerUseCapability, ComputerUseTarget } from "./computer-use-contract";
import type {
  LocalStore,
  MutationReceiptRecord,
  MutationReceiptStatus,
} from "./local-store";
import {
  createMultiplayerMutationScheduler,
  type MutationRejectionCode,
  type MutationRetryAction,
  type MultiplayerMutationScheduler,
} from "./multiplayer-mutation-scheduler";
import type { MultiplayerOperation } from "./multiplayer-contract";
import {
  createTargetIdentityRegistry,
  type MultiplayerTargetBinding,
  type TargetIdentityRegistry,
} from "./multiplayer-target-identity";

/**
 * Broker-owned mutation fence for the real production dispatch paths.
 *
 * The pure `multiplayer-mutation-scheduler` is intentionally process-local. The
 * owner broker is the one process that actually dispatches browser and desktop
 * input, so this module constructs exactly one scheduler there and shares it
 * between the browser broker and the desktop stage service. Provider MCP child
 * processes never own a fence; they carry a stable operation ID and observed
 * target revision to the owner.
 *
 * A transaction is deliberately short: acquire a lease, perform exactly one
 * bounded action, read the outcome back, then commit or abort. A terminal
 * receipt is durable in the shared local store so an owner-broker restart does
 * not forget which surface epoch it already committed.
 */

export type MutationFenceTargetKind = "browser-tab" | "desktop-window" | "desktop";

export interface MutationFenceTarget {
  readonly kind: MutationFenceTargetKind;
  /** Fence-owned surface identity. Stable across agents observing the same target. */
  readonly surfaceId: string;
  /** Opaque target identity used only for the target-identity registry. */
  readonly targetId: string;
  /** Provider-observed target revision string. Never used as the fence epoch. */
  readonly revision: string;
  /** Stable identity key persisted with the receipt, without a revision. */
  readonly targetKey: string;
  readonly browserInstanceId?: string;
  readonly tabId?: string;
  readonly windowRef?: string;
  readonly processId?: number;
}

export interface MutationFenceBeginInput {
  /** Authenticated provider handle. */
  readonly agent: string;
  readonly provider: string;
  readonly sessionId: string;
  /** Stable per-action identity supplied by the provider-facing computer-use tool. */
  readonly operationId: string;
  readonly target: MutationFenceTarget;
  /** Last fence epoch the caller observed. Omit only for a first observation. */
  readonly expectedMutationRevision?: number;
}

export type MutationFenceRejectionCode =
  | MutationRejectionCode
  | "already-terminal"
  | "already-claimed"
  | "surface-unresolved"
  | "receipt-store-unavailable"
  | "invalid-agent";

export interface MutationFenceReadback {
  readonly operationId: string;
  readonly surfaceId: string;
  readonly status: MutationReceiptStatus;
  readonly surfaceRevision: number;
  readonly targetRevision?: string;
  readonly detail?: string;
  /** False when the terminal state reached the in-memory fence but not the durable store. */
  readonly durable: boolean;
}

export interface MutationFenceOutcome {
  readonly status: "applied" | "refused" | "uncertain";
  readonly detail?: string;
}

export interface MutationFenceTransaction {
  readonly operationId: string;
  readonly surfaceId: string;
  readonly surfaceRevision: number;
  commit(outcome: MutationFenceOutcome): MutationFenceReadback;
  abort(reason: string, outcome?: MutationFenceOutcome): MutationFenceReadback;
  /** Release a transaction that provably never dispatched, so its operation ID may be retried. */
  release(reason: string): boolean;
}

export type MutationFenceBeginResult =
  | { readonly ok: true; readonly duplicate: false; readonly transaction: MutationFenceTransaction; readonly surfaceRevision: number }
  | { readonly ok: true; readonly duplicate: true; readonly receipt: MutationFenceReadback }
  | {
      readonly ok: false;
      readonly code: MutationFenceRejectionCode;
      readonly error: string;
      readonly retry: MutationRetryAction;
      readonly surfaceRevision?: number;
    };

export interface MultiplayerDispatchFence {
  begin(input: MutationFenceBeginInput): MutationFenceBeginResult;
  /** Current durable fence epoch for a surface. */
  surfaceRevision(surfaceId: string): number;
  /** Reconcile a prior uncertain dispatch after a fresh, successful observation. */
  observeSurface(surfaceId: string): number;
  /** Current epoch for the broker's canonical browser tab identity. */
  browserSurfaceRevision(ownerId: string | undefined, tab: string): number;
  snapshot(): { readonly activeSurfaceRevisions: Readonly<Record<string, number>> };
}

export interface MultiplayerDispatchFenceOptions {
  readonly store: Pick<LocalStore,
    "recordMutationReceipt" | "inspectMutationReceipt" | "removeMutationReceipt" | "listMutationReceipts"
    | "claimMutationReceipt" | "reconcileMutationSurface">;
  /** One owner broker is one run for fencing purposes; the roster is learned dynamically. */
  readonly runId?: string;
  readonly now?: () => number;
  readonly leaseTtlMs?: number;
  readonly targetRegistry?: TargetIdentityRegistry;
}

const MAX_IDENTIFIER = 128;

function safeId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function normalizeAgent(value: string): string {
  return value.replace(/^@+/, "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 160);
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDENTIFIER && /^[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(value);
}

/**
 * The broker's tab name is the canonical browser target inside the one owner
 * broker that actually dispatches input. It is explicit (never "the focused
 * tab"), and every agent targeting that tab derives the same surface ID.
 */
export function browserMutationTarget(input: {
  ownerId?: string;
  tab: string;
  revision?: string;
}): MutationFenceTarget {
  const owner = input.ownerId?.trim() || "local-machine";
  const tabKey = `${owner}\u0000${input.tab}`;
  const browserInstanceId = safeId("browser", owner);
  const tabId = safeId("tab", tabKey);
  const targetKey = `browser-tab|instance=${browserInstanceId}|tab=${tabId}`;
  return {
    kind: "browser-tab",
    surfaceId: safeId("surface", targetKey),
    targetId: safeId("target", targetKey),
    revision: input.revision?.trim().slice(0, 128) || "broker-observed",
    targetKey,
    browserInstanceId,
    tabId,
  };
}

/** One exact observed app window, keyed by the stage registry's verified PID/HWND pair. */
export function desktopWindowMutationTarget(input: {
  pid: number;
  windowId: string;
  revision?: string;
}): MutationFenceTarget {
  const targetKey = `desktop-window|pid=${input.pid}|window=${input.windowId}`;
  return {
    kind: "desktop-window",
    surfaceId: safeId("surface", targetKey),
    targetId: safeId("target", targetKey),
    revision: input.revision?.trim().slice(0, 128) || "stage-observed",
    targetKey,
    windowRef: safeId("window", targetKey),
    processId: input.pid,
  };
}

/** The physical desktop is one shared surface; separate windows use their own key. */
export function desktopMutationTarget(input: { revision?: string } = {}): MutationFenceTarget {
  const targetKey = "desktop|physical";
  return {
    kind: "desktop",
    surfaceId: safeId("surface", targetKey),
    targetId: safeId("target", targetKey),
    revision: input.revision?.trim().slice(0, 128) || "stage-observed",
    targetKey,
  };
}

function targetForBinding(target: MutationFenceTarget, now: number): ComputerUseTarget {
  const common = {
    targetId: target.targetId,
    revision: target.revision,
    observedAt: now,
    capabilities: [] as ComputerUseCapability[],
  };
  switch (target.kind) {
    case "browser-tab":
      return { ...common, kind: "browser-tab", browserInstanceId: target.browserInstanceId!, tabId: target.tabId! };
    case "desktop-window":
      return { ...common, kind: "desktop-window", windowRef: target.windowRef!, ...(target.processId ? { processId: target.processId } : {}) };
    case "desktop":
      return { ...common, kind: "desktop" };
  }
}

function refusal(
  code: MutationFenceRejectionCode,
  error: string,
  retry: MutationRetryAction,
  surfaceRevision?: number,
): MutationFenceBeginResult {
  return {
    ok: false,
    code,
    error: error.slice(0, 240),
    retry,
    ...(surfaceRevision === undefined ? {} : { surfaceRevision }),
  };
}

function readback(input: {
  operationId: string;
  surfaceId: string;
  status: MutationReceiptStatus;
  surfaceRevision: number;
  targetRevision?: string;
  detail?: string;
  durable: boolean;
}): MutationFenceReadback {
  return {
    operationId: input.operationId,
    surfaceId: input.surfaceId,
    status: input.status,
    surfaceRevision: input.surfaceRevision,
    ...(input.targetRevision === undefined ? {} : { targetRevision: input.targetRevision }),
    ...(input.detail === undefined ? {} : { detail: input.detail.slice(0, 240) }),
    durable: input.durable,
  };
}

export function createMultiplayerDispatchFence(options: MultiplayerDispatchFenceOptions): MultiplayerDispatchFence {
  const store = options.store;
  const now = options.now ?? Date.now;
  const runId = options.runId?.trim() || "m9r-owner";
  if (!validIdentifier(runId)) throw new Error("The multiplayer dispatch fence run ID is invalid.");
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;

  // Restore committed epochs before accepting any new lease. A store read failure
  // is fail-closed: the broker refuses mutations rather than silently resetting
  // every surface to epoch zero.
  let storeError: string | undefined;
  let prior: MutationReceiptRecord[] = [];
  try {
    prior = store.listMutationReceipts();
  } catch (error) {
    storeError = error instanceof Error ? error.message : "The multiplayer mutation receipt store could not be read.";
  }
  const initialSurfaceRevisions: Record<string, number> = {};
  const unresolvedSurfaces = new Set<string>();
  for (const receipt of prior) {
    if (receipt.status === "claimed" || receipt.status === "uncertain") unresolvedSurfaces.add(receipt.surfaceId);
    if (!Number.isSafeInteger(receipt.surfaceRevision) || receipt.surfaceRevision < 0) continue;
    initialSurfaceRevisions[receipt.surfaceId] = Math.max(initialSurfaceRevisions[receipt.surfaceId] ?? 0, receipt.surfaceRevision);
  }
  const inFlightSurfaceByOperation = new Map<string, string>();

  const targetRegistry = options.targetRegistry ?? createTargetIdentityRegistry();
  const scheduler: MultiplayerMutationScheduler = createMultiplayerMutationScheduler(
    {
      runId,
      agents: [{ agentId: "bootstrap", branchId: "bootstrap", provider: "m9r-owner" }],
    },
    {
      now,
      leaseTtlMs,
      initialSurfaceRevisions,
      targetRegistry,
    },
  );

  function currentRevision(surfaceId: string): number {
    return scheduler.snapshot().surfaceRevisions[surfaceId] ?? 0;
  }

  function persist(input: {
    branchId: string;
    agentId: string;
    handle: string;
    provider: string;
    operationId: string;
    surfaceId: string;
    targetKey: string;
    status: MutationReceiptStatus;
    surfaceRevision: number;
    targetRevision?: string;
    detail?: string;
  }): boolean {
    if (storeError) return false;
    try {
      const record = store.recordMutationReceipt({
        runId,
        branchId: input.branchId,
        agentId: input.agentId,
        handle: input.handle,
        provider: input.provider,
        operationId: input.operationId,
        surfaceId: input.surfaceId,
        targetKey: input.targetKey,
        status: input.status,
        surfaceRevision: input.surfaceRevision,
        ...(input.targetRevision === undefined ? {} : { targetRevision: input.targetRevision }),
        ...(input.detail === undefined ? {} : { detail: input.detail.slice(0, 240) }),
      });
      if (record.status !== input.status) {
        storeError = `The durable mutation receipt stayed ${record.status} instead of recording ${input.status}.`;
        return false;
      }
      return true;
    } catch (error) {
      storeError = error instanceof Error ? error.message : "The multiplayer mutation receipt could not be persisted.";
      return false;
    }
  }

  return {
    begin(input) {
      if (storeError) {
        return refusal("receipt-store-unavailable",
          `The owner broker cannot read its durable mutation receipts; no input was sent. ${storeError}`.slice(0, 240), "never");
      }
      if (!validIdentifier(input.operationId) || !input.target.surfaceId.trim() || !input.sessionId.trim()) {
        return refusal("invalid", "The mutation operation identity is invalid.", "never");
      }
      const handle = normalizeAgent(input.agent);
      if (!handle) return refusal("invalid-agent", "The mutation request has no authenticated agent handle.", "never");
      const agentId = safeId("agent", `${handle}\u0000${input.sessionId}`);
      const branchId = safeId("branch", input.sessionId);
      try {
        scheduler.registerAgent({ agentId, branchId, provider: input.provider.slice(0, 160) || "unknown", handle });
      } catch (error) {
        return refusal("invalid-agent", error instanceof Error ? error.message : "The mutation agent could not be registered.", "never");
      }

      const surfaceId = input.target.surfaceId;
      const surfaceRevision = currentRevision(surfaceId);
      if (unresolvedSurfaces.has(surfaceId)) {
        return refusal("surface-unresolved", "A prior action on this surface has an unresolved outcome. Refresh the target and inspect its current state before trying another action.", "refresh-target", surfaceRevision);
      }
      const receiptKey = { runId, branchId, agentId, surfaceId, operationId: input.operationId };
      let priorReceipt: MutationReceiptRecord | undefined;
      try {
        priorReceipt = store.inspectMutationReceipt(receiptKey);
      } catch (error) {
        storeError = error instanceof Error ? error.message : "The multiplayer mutation receipt could not be read.";
        return refusal("receipt-store-unavailable", "The owner broker cannot verify the action receipt; no input was sent.", "never", surfaceRevision);
      }
      if (priorReceipt) {
        if (priorReceipt.status === "claimed" || priorReceipt.status === "uncertain") {
          unresolvedSurfaces.add(surfaceId);
          return refusal("already-claimed", "This operation already has an unresolved receipt. Do not replay it; refresh the target and inspect the result first.", "refresh-target", surfaceRevision);
        }
        return refusal("already-terminal", `This operation already has a ${priorReceipt.status} receipt and cannot be replayed.`, "inspect-receipt", surfaceRevision);
      }
      const expected = input.expectedMutationRevision ?? surfaceRevision;
      if (!Number.isSafeInteger(expected) || expected < 0) {
        return refusal("invalid", "The expected mutation revision must be a nonnegative integer.", "never", surfaceRevision);
      }
      const schedulerOperationId = safeId("mut", `${agentId}\u0000${surfaceId}\u0000${input.operationId}`);
      const target = targetForBinding(input.target, now());
      const binding: MultiplayerTargetBinding = { runId, branchId, agentId, surfaceId, target };
      const operation: MultiplayerOperation = {
        runId,
        branchId,
        agentId,
        operationId: schedulerOperationId,
        surfaceId,
        revision: expected,
        kind: "mutate",
        createdAt: now(),
      };

      let begun;
      try {
        begun = scheduler.begin({
          operation,
          targetBinding: binding,
          expectedSurfaceRevision: expected,
          expectedSurfaceMutationRevision: expected,
        });
      } catch (error) {
        return refusal("invalid", error instanceof Error ? error.message : "The mutation fence refused the operation.", "never", surfaceRevision);
      }

      if (!begun.ok) {
        const code: MutationFenceRejectionCode = begun.code === "already-terminal" ? "already-terminal" : begun.code;
        return refusal(code, begun.error, begun.retry.action, surfaceRevision);
      }
      if (begun.duplicate) {
        const receipt = begun.receipt;
        return {
          ok: true,
          duplicate: true,
          receipt: readback({
            operationId: input.operationId,
            surfaceId,
            status: receipt.status,
            surfaceRevision: receipt.resultingSurfaceRevision ?? receipt.baseSurfaceRevision ?? surfaceRevision,
            targetRevision: input.target.revision,
            ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
            durable: true,
          }),
        };
      }

      let durableClaim;
      try {
        durableClaim = store.claimMutationReceipt({
          runId, branchId, agentId, handle, provider: input.provider,
          operationId: input.operationId, surfaceId, targetKey: input.target.targetKey,
          surfaceRevision, targetRevision: input.target.revision,
        });
      } catch (error) {
        storeError = error instanceof Error ? error.message : "The multiplayer mutation receipt could not be persisted.";
        scheduler.release(schedulerOperationId);
        targetRegistry.forget(binding);
        return refusal("receipt-store-unavailable", "The owner broker could not reserve the action receipt; no input was sent.", "never", surfaceRevision);
      }
      if (!durableClaim.claimed) {
        scheduler.release(schedulerOperationId);
        targetRegistry.forget(binding);
        const unresolved = durableClaim.record.status === "claimed" || durableClaim.record.status === "uncertain";
        if (unresolved) unresolvedSurfaces.add(surfaceId);
        return refusal(unresolved
          ? durableClaim.reason === "operation-exists" ? "already-claimed" : "surface-unresolved"
          : "already-terminal",
        unresolved ? "Another broker operation has an unresolved receipt for this surface. Refresh and inspect before trying another action."
          : `This operation already has a ${durableClaim.record.status} receipt and cannot be replayed.`,
        unresolved ? "refresh-target" : "inspect-receipt", surfaceRevision);
      }

      inFlightSurfaceByOperation.set(schedulerOperationId, surfaceId);
      let terminal: MutationFenceReadback | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const clearHeartbeat = (): void => { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; };
      const releaseInFlight = (): void => { inFlightSurfaceByOperation.delete(schedulerOperationId); };
      const finish = (result: MutationFenceReadback): MutationFenceReadback => {
        terminal = result;
        clearHeartbeat();
        targetRegistry.forget(binding);
        return result;
      };
      const markUncertain = (reason: string, dispatchFinished: boolean): MutationFenceReadback => {
        if (terminal) {
          if (dispatchFinished) releaseInFlight();
          return terminal;
        }
        const stopped = scheduler.abort(schedulerOperationId, reason);
        targetRegistry.release(schedulerOperationId);
        unresolvedSurfaces.add(surfaceId);
        if (dispatchFinished) releaseInFlight();
        const revision = stopped.receipt?.resultingSurfaceRevision ?? stopped.receipt?.baseSurfaceRevision ?? surfaceRevision;
        const detail = reason.slice(0, 240);
        const durable = persist({
          branchId, agentId, handle, provider: input.provider, operationId: input.operationId,
          surfaceId, targetKey: input.target.targetKey, status: "uncertain", surfaceRevision: revision,
          targetRevision: input.target.revision, detail,
        });
        return finish(readback({
          operationId: input.operationId, surfaceId, status: "uncertain", surfaceRevision: revision,
          targetRevision: input.target.revision, detail, durable,
        }));
      };
      const heartbeatMs = Math.max(25, Math.floor(leaseTtlMs / 3));
      heartbeat = setInterval(() => {
        if (terminal) return;
        if (!scheduler.renew(schedulerOperationId)) {
          // A timed-out dispatch must keep the surface closed until a read can
          // establish what the browser/desktop actually did.
          markUncertain("The mutation lease expired while the action outcome was still pending.", false);
        }
      }, heartbeatMs);
      heartbeat.unref?.();
      const transaction: MutationFenceTransaction = {
        operationId: input.operationId,
        surfaceId,
        surfaceRevision,
        commit(outcome) {
          if (terminal) {
            if (terminal.status === "uncertain") releaseInFlight();
            return terminal;
          }
          if (outcome.status === "uncertain") return markUncertain(outcome.detail ?? "The action outcome is uncertain.", true);
          if (outcome.status === "refused") return transaction.abort(outcome.detail ?? "The action was refused before it could be applied.", outcome);
          const committed = scheduler.commit(schedulerOperationId);
          if (!committed.ok) {
            // Input may already have changed the page/window; a failed lease
            // commit is an unknown outcome, never a clean expired/aborted retry.
            return markUncertain(outcome.detail ?? committed.error, true);
          }
          const receipt = committed.receipt;
          const revision = receipt.resultingSurfaceRevision ?? surfaceRevision + 1;
          const persisted = persist({
            branchId, agentId, handle, provider: input.provider, operationId: input.operationId,
            surfaceId, targetKey: input.target.targetKey, status: "committed", surfaceRevision: revision,
            targetRevision: input.target.revision, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          });
          const result = finish(readback({
            operationId: input.operationId, surfaceId, status: "committed", surfaceRevision: revision,
            targetRevision: input.target.revision,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            durable: persisted,
          }));
          unresolvedSurfaces.delete(surfaceId);
          releaseInFlight();
          return result;
        },
        abort(reason, outcome = { status: "refused" }) {
          if (terminal) {
            if (terminal.status === "uncertain") releaseInFlight();
            return terminal;
          }
          if (outcome.status === "uncertain") return markUncertain(outcome.detail ?? reason, true);
          const aborted = scheduler.abort(schedulerOperationId, reason);
          const receipt = aborted.receipt;
          const status: MutationReceiptStatus = receipt?.status === "expired" ? "expired"
            : receipt?.status === "stale" ? "stale" : "aborted";
          const revision = receipt?.resultingSurfaceRevision ?? receipt?.baseSurfaceRevision ?? surfaceRevision;
          const detail = outcome.detail ?? reason;
          const persisted = persist({
            branchId, agentId, handle, provider: input.provider, operationId: input.operationId,
            surfaceId, targetKey: input.target.targetKey, status, surfaceRevision: revision,
            targetRevision: input.target.revision, detail,
          });
          const result = finish(readback({
            operationId: input.operationId, surfaceId, status, surfaceRevision: revision,
            targetRevision: input.target.revision, detail, durable: persisted,
          }));
          unresolvedSurfaces.delete(surfaceId);
          releaseInFlight();
          return result;
        },
        release(reason) {
          if (terminal) return false;
          const released = scheduler.release(schedulerOperationId);
          if (!released) return false;
          try {
            store.removeMutationReceipt({
              runId, branchId, agentId, surfaceId, operationId: input.operationId,
            });
          } catch {
            // A claimed receipt left behind still blocks replay; it is not a reason to dispatch again.
          }
          finish(readback({
            operationId: input.operationId, surfaceId, status: "aborted", surfaceRevision,
            targetRevision: input.target.revision, detail: reason, durable: true,
          }));
          releaseInFlight();
          return true;
        },
      };
      return { ok: true, duplicate: false, transaction, surfaceRevision };
    },

    surfaceRevision(surfaceId) {
      return currentRevision(surfaceId);
    },

    observeSurface(surfaceId) {
      const current = currentRevision(surfaceId);
      if (!unresolvedSurfaces.has(surfaceId)) return current;
      if ([...inFlightSurfaceByOperation.values()].includes(surfaceId)) return current;
      const next = scheduler.advanceSurfaceRevision(surfaceId);
      if (next === undefined) return current;
      try {
        store.reconcileMutationSurface(surfaceId, next);
        unresolvedSurfaces.delete(surfaceId);
        return next;
      } catch (error) {
        storeError = error instanceof Error ? error.message : "The mutation receipt could not be reconciled.";
        return current;
      }
    },

    browserSurfaceRevision(ownerId, tab) {
      return currentRevision(browserMutationTarget({ ownerId, tab }).surfaceId);
    },

    snapshot() {
      return { activeSurfaceRevisions: { ...scheduler.snapshot().surfaceRevisions } };
    },
  };
}
