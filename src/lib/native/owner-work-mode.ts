import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { renameStateFile } from "./atomic-file";
import { DesktopInputNotDispatchedError } from "./desktop-input-errors";
import type { StageApprovalRequest } from "./web-broker-core";

export type OwnerWorkMode = "working" | "agents-free";
export function isOwnerWorkMode(value: unknown): value is OwnerWorkMode { return value === "working" || value === "agents-free"; }
export interface ForegroundAuthorizationResult {
  readonly restoreOwnerContext: boolean;
  /** Physical-input checkpoint captured after approval; the native boundary rechecks it. */
  readonly ownerInputEpoch?: number;
  /** Keep the low-level input monitor alive while this task's approval grant is live. */
  readonly retainOwnerInputMonitor?: boolean;
}

function foregroundGrantKey(pid: unknown, windowId: unknown): string | undefined {
  const processId = typeof pid === "number" ? pid : typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : NaN;
  const handle = typeof windowId === "string" && /^(?:0[xX][0-9a-f]+|[0-9]+)$/i.test(windowId) ? windowId : undefined;
  if (!Number.isSafeInteger(processId) || processId < 1 || !handle) return undefined;
  try { return `foreground:${processId}:${BigInt(handle).toString()}`; } catch { return undefined; }
}
export function readOwnerWorkPreference(root: string): { mode: OwnerWorkMode; revision: string } {
  const path = join(root, "owner-work-mode.json");
  if (!existsSync(path)) return { mode: "working", revision: "unset" };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || !isOwnerWorkMode(value.mode) || (value.revision !== undefined && !/^[a-f0-9-]{36}$/.test(value.revision))) throw new Error("The owner work-mode preference is invalid; foreground input remains unavailable until it is set again.");
  return { mode: value.mode, revision: value.revision ?? "legacy" };
}
export function readOwnerWorkMode(root: string): OwnerWorkMode { return readOwnerWorkPreference(root).mode; }
export function setOwnerWorkMode(root: string, mode: OwnerWorkMode): void {
  if (!isOwnerWorkMode(mode)) throw new Error("Invalid owner work mode.");
  mkdirSync(root, { recursive: true });
  const temporary = join(root, `owner-work-mode.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ version: 1, mode, revision: randomUUID() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameStateFile(temporary, join(root, "owner-work-mode.json"));
}

interface ForegroundGrant { revision: string; ownerInputEpoch?: number }
type Turn = { agent: string; provider: string; sessionId: string; taskId: string; signal: AbortSignal;
  grants: Map<string, ForegroundGrant>; oneShotGrants: Map<string, string>; assertActive?: () => void;
  stageName?: string; operationId?: string;
  readOwnerInputEpoch?: () => Promise<number>; captureOwnerInputEpoch?: (leaseKey: string) => Promise<number>;
  releaseOwnerInputMonitor?: (leaseKey: string) => Promise<void> };
type GrantOwner = Pick<Turn, "agent" | "provider" | "sessionId" | "taskId">;
export interface ForegroundAuthorizationTrace {
  readonly taskId: string;
  readonly stageName?: string;
  readonly operationId?: string;
  readonly operation: string;
  readonly decision: "agents-free" | "restore-authorized" | "restore-refused" | "grant-reused" | "approval-granted" | "approval-denied" | "refused";
  readonly reason: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
}
function grantOwnerKey(owner: GrantOwner): string {
  return JSON.stringify([owner.agent.trim().replace(/^@+/, "").toLowerCase(), owner.provider.trim().toLowerCase(), owner.sessionId, owner.taskId]);
}

/**
 * Foreground approval is retained for the exact agent session, task, and HWND.
 * Tool calls are separate broker operations, so an operation-local grant made
 * every key/click after the first one ask again. Background routes remain the
 * default; this only carries a user-approved fallback across the same task and
 * window. Mode changes, task/session changes, task pause/end, or another HWND
 * invalidate or miss the grant.
 */
export function createOwnerWorkPolicy(root: string,
  approvals: () => { requestApproval(request: StageApprovalRequest): Promise<boolean> } | undefined,
  options: { isTaskActive?: (taskId: string) => boolean; onTaskRevoked?: (owner: GrantOwner, leaseKey: string) => void;
    onAuthorizationDecision?: (event: ForegroundAuthorizationTrace) => void } = {}) {
  const context = new AsyncLocalStorage<Turn>();
  const grantsByOwner = new Map<string, Map<string, ForegroundGrant>>();
  const parseGrantOwner = (key: string): GrantOwner | undefined => {
    try {
      const parts = JSON.parse(key) as unknown[];
      if (parts.length !== 4 || !parts.every((part) => typeof part === "string")) return undefined;
      return { agent: parts[0] as string, provider: parts[1] as string,
        sessionId: parts[2] as string, taskId: parts[3] as string };
    } catch { return undefined; }
  };
  const notifyRevoked = (key: string, owner?: GrantOwner): void => {
    if (!owner) return;
    try { options.onTaskRevoked?.(owner, key); } catch { /* cleanup failure cannot grant authority */ }
  };
  function revokeOwnerKey(key: string): void {
    if (!grantsByOwner.delete(key)) return;
    notifyRevoked(key, parseGrantOwner(key));
  }
  function reapRevokedGrants(): void {
    const isTaskActive = options.isTaskActive;
    let revision: string | undefined;
    try { revision = readOwnerWorkPreference(root).revision; } catch { /* malformed mode state revokes cached foreground authority */ }
    for (const [key, grants] of grantsByOwner) {
      const owner = parseGrantOwner(key);
      let taskActive = false;
      try { taskActive = Boolean(owner && (!isTaskActive || isTaskActive(owner.taskId))); } catch { taskActive = false; }
      if (!taskActive) { revokeOwnerKey(key); continue; }
      if (revision === undefined) { revokeOwnerKey(key); continue; }
      for (const [target, grant] of grants) if (grant.revision !== revision) grants.delete(target);
      if (grants.size === 0) revokeOwnerKey(key);
    }
  }
  function activeGrantMap(owner: GrantOwner): Map<string, ForegroundGrant> {
    reapRevokedGrants();
    const isTaskActive = options.isTaskActive;
    const key = grantOwnerKey(owner);
    if (isTaskActive && !isTaskActive(owner.taskId)) {
      grantsByOwner.delete(key);
      notifyRevoked(key, owner);
      return new Map();
    }
    let grants = grantsByOwner.get(key);
    if (!grants) { grants = new Map(); grantsByOwner.set(key, grants); }
    return grants;
  }
  return {
    run<T>(turn: Omit<Turn, "grants" | "oneShotGrants">, operation: () => Promise<T>): Promise<T> {
      const key = grantOwnerKey(turn);
      const grants = activeGrantMap(turn);
      return context.run({ ...turn, grants, oneShotGrants: new Map() }, operation).finally(() => {
        if (grants.size === 0 && grantsByOwner.get(key) === grants) grantsByOwner.delete(key);
      });
    },
    /** Explicit stop/pause revokes only this agent's task grant. */
    revokeTask(owner: GrantOwner): void {
      const agent = owner.agent.trim().replace(/^@+/, "").toLowerCase();
      // Revocation may be initiated by task/cursor housekeeping that knows the
      // authenticated agent session but not its provider alias. Deleting any
      // provider-scoped grant for the same exact task/session is safe; retaining
      // one would leave foreground authority alive after stop or pause.
      for (const [key] of grantsByOwner) {
        const candidate = parseGrantOwner(key);
        if (candidate && candidate.agent === agent && candidate.sessionId === owner.sessionId && candidate.taskId === owner.taskId) {
          revokeOwnerKey(key);
        }
      }
    },
    /** Called only after the launcher resolves and natively attaches its new app HWND. Not an agent API. */
    carryLaunchGrant(appId: string, pid: number, windowId: string): void {
      const turn = context.getStore();
      if (!turn || !Number.isSafeInteger(pid) || pid < 1 || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(windowId)) throw new DesktopInputNotDispatchedError("The launched window has no exact foreground authorization context.", "foreground-approval");
      turn.signal.throwIfAborted(); turn.assertActive?.();
      const current = readOwnerWorkPreference(root);
      if (current.mode === "agents-free") return;
      const launchGrant = turn.grants.get(`desktop:app:${appId}`);
      if (launchGrant?.revision === current.revision) {
        const key = foregroundGrantKey(pid, windowId);
        if (key) turn.grants.set(key, { ...launchGrant });
      }
    },
    async authorize(request: Record<string, unknown>): Promise<ForegroundAuthorizationResult> {
      const turn = context.getStore();
      if (!turn) throw new DesktopInputNotDispatchedError("Foreground input requires an active broker-owned task turn; no input was sent.", "foreground-lease");
      const traceStarted = performance.now();
      let traceWritten = false;
      const operation = typeof request.op === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(request.op) ? request.op : "unknown";
      const trace = (decision: ForegroundAuthorizationTrace["decision"], reason: string): void => {
        if (traceWritten) return;
        traceWritten = true;
        try { options.onAuthorizationDecision?.({ taskId: turn.taskId,
          ...(turn.stageName && /^[a-zA-Z0-9._:-]{1,96}$/.test(turn.stageName) ? { stageName: turn.stageName } : {}),
          ...(turn.operationId && /^[a-zA-Z0-9._:-]{1,128}$/.test(turn.operationId) ? { operationId: turn.operationId } : {}),
          operation, decision, reason: /^[a-zA-Z0-9._:-]{1,96}$/.test(reason) ? reason : "authorization-error",
          durationMs: Math.max(0, performance.now() - traceStarted),
          status: decision === "refused" || decision === "approval-denied" || decision === "restore-refused" ? "error" : "ok" }); }
        catch { /* diagnostics cannot affect whether an input operation is authorized */ }
      };
      try {
      turn.signal.throwIfAborted();
      turn.assertActive?.();
      const preference = readOwnerWorkPreference(root);
      const hadPriorModeGrant = [...turn.grants.values()].some((grant) => grant.revision !== preference.revision);
      const invalidateChangedModeGrants = async (revision = preference.revision): Promise<void> => {
        let removed = false;
        for (const [key, grant] of turn.grants) if (grant.revision !== revision) {
          turn.grants.delete(key); removed = true;
        }
        if (removed && turn.grants.size === 0) {
          grantsByOwner.delete(grantOwnerKey(turn));
          try { await turn.releaseOwnerInputMonitor?.(grantOwnerKey(turn)); } catch { /* no authority survives a mode change */ }
        }
      };
      await invalidateChangedModeGrants();
      if (preference.mode === "agents-free") {
        trace("agents-free", "agents-free-mode");
        return { restoreOwnerContext: false };
      }
      if (request.op === "restoreForegroundContext") {
        const key = foregroundGrantKey(request.pid, request.windowId);
        const valid = Boolean(key && turn.grants.get(key)?.revision === preference.revision);
        trace(valid ? "restore-authorized" : "restore-refused", valid ? "matching-current-grant" : "no-matching-current-grant");
        return { restoreOwnerContext: valid, retainOwnerInputMonitor: valid };
      }
      const globalMediaInput = request.op === "systemControl" && request.control === "media";
      if (globalMediaInput && !["play_pause", "next", "previous"].includes(String(request.action))) {
        throw new DesktopInputNotDispatchedError("The requested global media key is not supported; no media input was sent.", "foreground-approval");
      }
      if (request.op === "restoreCursorPosition" && [...turn.grants.entries()].some(([key, grant]) =>
        key.startsWith("foreground:") && grant.revision === preference.revision)) {
        trace("restore-authorized", "preserve-active-foreground-monitor");
        return { restoreOwnerContext: false, retainOwnerInputMonitor: true };
      }
      const launchTarget = request.op === "launch" && typeof request.windowId === "string"
        && /^app:[a-z0-9._-]{1,80}$/i.test(request.windowId)
        ? `desktop:${request.windowId}` : undefined;
      const target = globalMediaInput
        ? `global:media:${String(request.action)}`
        : launchTarget ?? foregroundGrantKey(request.pid, request.windowId) ?? `foreground:desktop:${String(request.windowId ?? "desktop")}`;
      const readInputEpoch = async (): Promise<number | undefined> => {
        if (globalMediaInput || !turn.readOwnerInputEpoch) return undefined;
        try {
          const epoch = await turn.readOwnerInputEpoch();
          return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined;
        } catch {
          return undefined;
        }
      };
      const inputEpoch = await readInputEpoch();
      const existingGrant = globalMediaInput ? undefined : turn.grants.get(target);
      let approvalReason = hadPriorModeGrant ? "mode-revision-changed" : "new-target-or-no-grant";
      const savedInputEpochUnavailable = [...turn.grants.values()].some((grant) => grant.ownerInputEpoch === undefined);
      const savedInputEpochChanged = [...turn.grants.values()].some((grant) => grant.ownerInputEpoch !== inputEpoch);
      if (!globalMediaInput && turn.readOwnerInputEpoch && (inputEpoch === undefined || savedInputEpochChanged)) {
        approvalReason = inputEpoch === undefined || savedInputEpochUnavailable
          ? "owner-input-epoch-unavailable" : "owner-input-changed";
        turn.grants.clear();
        try { await turn.releaseOwnerInputMonitor?.(grantOwnerKey(turn)); } catch { /* no stale foreground grant survives an unknown/changed epoch */ }
      }
      if (globalMediaInput
        ? turn.oneShotGrants.get(target) === preference.revision
        : existingGrant?.revision === preference.revision
          && (!turn.readOwnerInputEpoch || (inputEpoch !== undefined && existingGrant.ownerInputEpoch === inputEpoch))) {
        trace("grant-reused", turn.readOwnerInputEpoch ? "same-target-and-owner-input-epoch" : "same-target-and-mode-revision");
        return { restoreOwnerContext: !globalMediaInput,
          ...(!globalMediaInput && existingGrant?.ownerInputEpoch !== undefined ? { ownerInputEpoch: existingGrant.ownerInputEpoch } : {}) };
      }
      if (existingGrant && existingGrant.revision === preference.revision) turn.grants.delete(target);
      const route = approvals();
      if (!route) {
        trace("refused", "approval-route-unavailable");
        if (!globalMediaInput && turn.grants.size === 0) {
          try { await turn.releaseOwnerInputMonitor?.(grantOwnerKey(turn)); } catch { /* the action remains refused */ }
        }
        throw new DesktopInputNotDispatchedError(globalMediaInput
          ? "I'm Working is active. This global media action needs owner approval; the approval route is unavailable. No media key was sent."
          : "I'm Working is active. This action needs a foreground turn; the owner approval route is unavailable. No input was sent.", "foreground-approval");
      }
      const waiting = new AbortController();
      const cancel = () => waiting.abort(turn.signal.reason);
      turn.signal.addEventListener("abort", cancel, { once: true });
      const modePoll = setInterval(() => { try { if (readOwnerWorkPreference(root).revision !== preference.revision) waiting.abort(); } catch { waiting.abort(); } }, 100);
      modePoll.unref();
      let accepted: boolean;
      const approval = globalMediaInput
        ? { step: `Allow @${turn.agent} to send the ${String(request.action).replaceAll("_", " ")} media key? It may control the active media app.`,
            action: "global_media_key", risk: "global-media-input" }
        : { step: `Allow @${turn.agent} to use this window in the foreground for this task? M9R will restore your current window after each operation and yield if you interact.`,
            action: "foreground_turn", risk: "foreground-input" };
      try { accepted = await route.requestApproval({ agent: turn.agent, provider: turn.provider, sessionId: turn.sessionId,
        ...approval, timeoutMs: 55_000, signal: waiting.signal }); }
      catch (error) {
        if (!globalMediaInput && turn.grants.size === 0) {
          try { await turn.releaseOwnerInputMonitor?.(grantOwnerKey(turn)); } catch { /* the action remains refused */ }
        }
        throw error;
      }
      finally { clearInterval(modePoll); turn.signal.removeEventListener("abort", cancel); }
      turn.signal.throwIfAborted();
      turn.assertActive?.();
      const current = readOwnerWorkPreference(root);
      if (current.mode === "agents-free") {
        await invalidateChangedModeGrants(current.revision);
        trace("agents-free", "mode-changed-while-approval-waited");
        return { restoreOwnerContext: false };
      }
      if (current.revision !== preference.revision) {
        await invalidateChangedModeGrants(current.revision);
        trace("refused", "mode-changed-while-approval-waited");
        throw new DesktopInputNotDispatchedError("The owner changed the work mode while this foreground turn was waiting. No input was sent; request a new turn.", "foreground-approval");
      }
      if (!accepted) {
        trace("approval-denied", "owner-denied-or-approval-timed-out");
        if (!globalMediaInput && turn.grants.size === 0) {
          try { await turn.releaseOwnerInputMonitor?.(grantOwnerKey(turn)); } catch { /* the action remains refused */ }
        }
        throw new DesktopInputNotDispatchedError(globalMediaInput
          ? "The global media action is waiting for owner approval. No media key was sent; retry when approved or switch to Agents Free."
          : "The foreground turn is waiting for owner approval. No input was sent; retry when approved or switch to Agents Free.", "foreground-approval");
      }
      // Global media is intentionally a one-operation approval. Window
      // authority can continue across actions in this task only while the
      // physical-input epoch is unchanged; the owner returning to work expires
      // the foreground turn and makes a later turn ask again.
      if (globalMediaInput) {
        turn.oneShotGrants.set(target, current.revision);
        trace("approval-granted", "global-media-one-shot");
        return { restoreOwnerContext: false };
      }
      let approvedAtInputEpoch: number | undefined;
      let grantInstalled = false;
      try {
        if (turn.captureOwnerInputEpoch) {
          try { approvedAtInputEpoch = await turn.captureOwnerInputEpoch(grantOwnerKey(turn)); }
          catch (error) {
            throw new DesktopInputNotDispatchedError(
              `The owner input monitor could not be established after approval; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
              "foreground-approval");
          }
        } else approvedAtInputEpoch = await readInputEpoch();
        turn.signal.throwIfAborted(); turn.assertActive?.();
        const afterCapturePreference = readOwnerWorkPreference(root);
        if (afterCapturePreference.mode !== "working" || afterCapturePreference.revision !== preference.revision) {
          await invalidateChangedModeGrants(afterCapturePreference.revision);
          throw new DesktopInputNotDispatchedError("Owner mode changed while the foreground turn was being captured. No input was sent.", "foreground-approval");
        }
        if (turn.captureOwnerInputEpoch && approvedAtInputEpoch === undefined) {
          throw new DesktopInputNotDispatchedError("The owner input monitor returned no checkpoint; no foreground input was sent.", "foreground-approval");
        }
        turn.grants.set(target, { revision: current.revision,
          ...(approvedAtInputEpoch !== undefined ? { ownerInputEpoch: approvedAtInputEpoch } : {}) });
        grantInstalled = true;
        trace("approval-granted", approvalReason);
        return { restoreOwnerContext: true,
          retainOwnerInputMonitor: Boolean(turn.captureOwnerInputEpoch),
          ...(approvedAtInputEpoch !== undefined ? { ownerInputEpoch: approvedAtInputEpoch } : {}) };
      } finally {
        if (!grantInstalled && turn.grants.size === 0) {
          grantsByOwner.delete(grantOwnerKey(turn));
          try { await turn.releaseOwnerInputMonitor?.(grantOwnerKey(turn)); } catch { /* the action remains refused */ }
        }
      }
      } catch (error) {
        trace("refused", error instanceof DesktopInputNotDispatchedError ? error.code : "authorization-error");
        throw error;
      }
    },
    /** Periodically drop approvals for paused/finished tasks and changed modes. */
    reapRevokedGrants: reapRevokedGrants,
  };
}
