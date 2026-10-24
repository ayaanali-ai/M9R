/**
 * The M9R Node's local state for the native front door: endpoints seen on this machine, tasks and inbox cursors.
 * One small JSON file under the user's M9R home, written atomically and guarded by a lock directory so a hook and the
 * CLI can never corrupt each other. Everything is synchronous: a hook is a short-lived process.
 *
 * Local first: nothing here needs the network or an account (design section 1, principle 7).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { isProtectedAction, lapsedPending, ruleCovers, type StandingRule } from "./approval-core";
import { MAX_RESULT_SUMMARY_CHARS, TRUNCATION_MARKER, findByIdempotencyKey, inboxMaxAgeMs, isFreshInboxTask, newTask, normalizeHandle, pruneTasks, redactSecrets, transitionTaskReceipt, type Approval, type NewTaskInput, type StageTimingEvent, type Task, type TaskDelivery, type TaskLifecycle, type TaskReceiptSource, type TaskReceiptState } from "./inbox-core";
import { canQueue, normCwd } from "./codex-delivery-core";
import { issueIdentity, verifyToken, type IdentityToken, type VerifiedIdentity } from "./identity-core";
import { CONNECTION_CLAIM_TTL_MS, MAX_CONNECTION_RECORDS, PROVIDER_SESSION_RECOVERY_TTL_MS, PROVIDER_TURN_TTL_MS, newConnectionId, sameConnectionCwd, sameConnectionProvider, usableConnectionClaim, validConnectionProcessId, type ConnectionBinding, type ConnectionClaim, type ConnectionClaimInput, type BindConnectionInput } from "./mcp-connection-core";
import { createInitialProviderUpdateState, normalizeProviderUpdateState, type ProviderUpdateState } from "./provider-update-lifecycle-core";

/**
 * Findings I/AD: this is the one place a native cursor/feed color is chosen for an agent handle.
 * The current owner-approved demo palette is fixed by provider identity: Codex blue, Claude
 * terracotta, and OpenCode light gray. Unknown providers use the overflow palette and retain
 * their first assignment. Reserved provider colors are skipped by overflow allocation so a newly
 * seen provider cannot steal a color that belongs to a known provider.
 */
const CURSOR_BRAND_COLORS: Readonly<Record<string, string>> = {
  codex: "#4F7CFF",
  claude: "#D97757",
  opencode: "#9CA3AF",
};
const CURSOR_COLOR_PALETTE: readonly string[] = [
  "#34D399", "#F59E0B", "#EC4899", "#38BDF8", "#A78BFA", "#FB7185",
];
const RESERVED_CURSOR_COLORS = new Set(Object.values(CURSOR_BRAND_COLORS));

function rememberDelivery(task: Task): void {
  if (task.delivery) task.deliveryHistory = [...(task.deliveryHistory ?? []), { ...task.delivery }].slice(-20);
}

function recordTaskReceipt(task: Task, transition: {
  state: TaskReceiptState;
  at: string;
  attempt?: number;
  source?: TaskReceiptSource;
  sessionId?: string;
  error?: string;
}): void {
  task.receipt = transitionTaskReceipt(task.receipt, {
    ...transition,
    ...(transition.error ? { error: redactSecrets(transition.error).slice(0, 500) } : {}),
  });
}

function receiptStateForDelivery(task: Task, state: TaskDelivery["state"]): TaskReceiptState {
  if (state === "sending") return "dispatched";
  if (state === "queued") return "provider_received";
  if (state === "uncertain") return "uncertain";
  if (state === "failed") return "failed";
  if (state === "done") return "completed";
  // The first deferred write is merely an accepted task waiting for an
  // adapter. A later deferred write is an explicit retry after a failure.
  return task.receipt?.state === "failed" || task.receipt?.state === "uncertain" || (task.delivery?.attempts ?? 0) > 0
    ? "retryable"
    : "accepted";
}

export interface EndpointRecord {
  handle: string;
  provider: string;
  sessionId?: string;
  cwd?: string;
  lastSeenAt: string;
}

/** One agent session seen on this machine. An agent can have several open at once (N4). */
export interface SessionRecord {
  handle: string;
  provider: string;
  sessionId: string;
  cwd?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EventRecord {
  at: string;
  kind: "agent.connected" | "session.started" | "task.created" | "task.delivered" | "task.delivery_failed" | "task.delivery_uncertain" | "task.canceled" | "task.approved" | "task.denied" | "task.expired" | "task.result" | "rule.created" | "rule.revoked" | "mention.double";
  handle?: string;
  taskId?: string;
  text: string;
}

const MAX_EVENTS = 500;
/** Keep receipts for recent stage actions so an MCP retry cannot repeat an OS input. */
const MAX_STAGE_OPERATION_RECEIPTS = 10_000;
/** Keep durable phase history bounded even for a long-running task/session. */
const MAX_STAGE_TIMING_EVENTS_PER_TASK = 256;
const MAX_STAGE_TIMING_DETAIL_CHARS = 240;
/** Keep generic computer-use receipts across broker/client restarts; fail closed rather than evicting replay protection. */
const MAX_COMPUTER_OPERATION_RECEIPTS = 10_000;
/** Hard ceiling for the complete local snapshot, including extensible cursor and rule maps. */
export const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024;
/** Keep each rewritten local state file within a predictable task count when user work can be retired safely. */
export const MAX_STORED_TASKS = 2_000;
const RESOLVED_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
/**
 * Result collectors are reconciliation workers, not an authority to resurrect
 * an old delivery. Keep a generous window for genuinely long provider turns,
 * but stop polling records that have been waiting for a result for a day. The
 * task remains in state.json as history; a separate lifecycle policy can retire
 * it later only with stronger evidence that the provider session is gone.
 */
export const RESULT_RECONCILIATION_MAX_AGE_MS = 24 * 60 * 60_000;
/** How long a task's last recorded stage activity still counts as "the current turn" for
 *  mostRecentlyActiveTaskId -- a real turn's calls happen seconds to low minutes apart. */
const ACTIVE_TURN_WINDOW_MS = 5 * 60_000;

export class LocalStateCapacityError extends Error {
  readonly code = "M9R_LOCAL_STATE_CAPACITY";

  constructor(bytes: number, limit: number) {
    super(`The local state file exceeds its safe capacity (${bytes}/${limit} bytes); it was left unchanged.`);
    this.name = "LocalStateCapacityError";
  }
}

export class LocalTaskCapacityError extends Error {
  readonly code = "M9R_LOCAL_TASK_CAPACITY";

  constructor(retainedTasks: number) {
    super(`The local task store is at capacity (${retainedTasks}/${MAX_STORED_TASKS} tasks remain unresolved or unread). Complete or read existing work before sending more.`);
    this.name = "LocalTaskCapacityError";
  }
}

export interface StageOperationInput {
  handle: string;
  sessionId: string;
  taskId: string;
  operationId: string;
  fingerprint: string;
}

export type StageOperationClaim = { state: "claimed" | "in_progress" | "applied" | "uncertain" | "conflict"; updatedAt?: string };

/** Provider-neutral idempotency identity for an action dispatched through any computer-use backend. */
export interface ComputerOperationInput {
  handle: string;
  sessionId: string;
  targetId: string;
  operationId: string;
  fingerprint: string;
}

interface ComputerOperationRecord extends ComputerOperationInput {
  key: string;
  state: "running" | "applied" | "uncertain";
  updatedAt: string;
}

interface StageOperationRecord {
  key: string;
  handle: string;
  sessionId: string;
  taskId: string;
  fingerprint: string;
  state: "running" | "applied" | "uncertain";
  updatedAt: string;
}

interface StoreState {
  version: 1;
  nextTaskNo: number;
  nextSeq: Record<string, number>;
  tasks: Task[];
  cursors: Record<string, number>;
  endpoints: Record<string, EndpointRecord>;
  events: EventRecord[];
  /** N5 standing rules: an agent may hand work to another without asking each time, for a limited time. */
  rules: StandingRule[];
  nextRuleNo: number;
  sessions: SessionRecord[];
  /** Explicit or auto-made links between two sessions (see routing in codex-delivery.ts). */
  links: SessionLink[];
  nextLinkNo: number;
  /** P1 identity: one token per session, issued at SessionStart. See identity-core.ts. */
  identities: IdentityToken[];
  /** Durable one-shot receipts for mutating desktop-stage operations. */
  stageOperations: StageOperationRecord[];
  /** Durable one-shot receipts for provider-neutral computer-use operations. */
  computerOperations: ComputerOperationRecord[];
  /** Private provider-to-MCP claims; never rendered in provider prompts or tool arguments. */
  connectionClaims: ConnectionClaim[];
  /** Durable MCP bindings; a worker restart may reuse one while the provider identity is active. */
  connectionBindings: ConnectionBinding[];
  /** Exact provider turn context published by trusted hooks for shared MCP processes. */
  activeProviderTurns: ActiveProviderTurn[];
  /** Provider-neutral compatibility observations; this contains no credentials or raw provider config. */
  providerUpdates: ProviderUpdateState["providers"];
  /**
   * Findings I/AD: one durable color per agent handle, allocated once and shared by every
   * surface that shows that agent's identity (the pill, the native cursor overlay once it
   * supports per-agent theming). Replaces ad hoc hardcoded color maps that drifted independently
   * of each other (confirmed live: the pill's own Codex color was found changed between two
   * audits in the same night, with nothing keeping it in sync with anything else).
   */
  cursorColors: Record<string, string>;
}

interface ActiveProviderTurn {
  handle: string;
  provider: string;
  sessionId: string;
  turnId?: string;
  processId: number;
  cwd?: string;
  startedAt: string;
  expiresAt: string;
}

export interface SessionLink {
  id: string;
  a: { handle: string; sessionId: string; cwd?: string };
  b: { handle: string; sessionId: string; cwd?: string };
  origin: "auto" | "picked";
  createdAt: string;
  updatedAt: string;
}

const emptyState = (): StoreState => ({ version: 1, nextTaskNo: 1, nextSeq: {}, tasks: [], cursors: {}, endpoints: {}, events: [], rules: [], nextRuleNo: 1, sessions: [], links: [], nextLinkNo: 1, identities: [], stageOperations: [], computerOperations: [], connectionClaims: [], connectionBindings: [], activeProviderTurns: [], providerUpdates: createInitialProviderUpdateState().providers, cursorColors: {} });

const stageOperationKey = (input: StageOperationInput): string => createHash("sha256")
  .update(JSON.stringify([normalizeHandle(input.handle), input.sessionId, input.taskId, input.operationId]))
  .digest("hex");

const computerOperationKey = (input: ComputerOperationInput): string => createHash("sha256")
  .update(JSON.stringify([normalizeHandle(input.handle), input.sessionId, input.targetId, input.operationId]))
  .digest("hex");

const normalizeSessionFolder = (cwd?: string): string => {
  const value = cwd?.trim();
  if (!value) return "";
  if (win32.isAbsolute(value)) {
    const normalized = win32.normalize(value).replace(/\\/g, "/").toLowerCase();
    return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/$/, "");
  }
  if (posix.isAbsolute(value)) return posix.normalize(value).replace(/\/$/, "") || "/";
  return "";
};

/** The per-user M9R home is install state, never a project/session folder. */
const isWithinStoreRoot = (storeRoot: string, candidate?: string): boolean => {
  const root = normalizeSessionFolder(storeRoot);
  const path = normalizeSessionFolder(candidate);
  return Boolean(root && path && (path === root || path.startsWith(`${root}/`)));
};

/** Drop an inherited broker/engine cwd when it points inside ~/.m9r. */
const projectCwd = (storeRoot: string, cwd?: string): string | undefined => isWithinStoreRoot(storeRoot, cwd) ? undefined : cwd;

/** Normalize a persisted session reference at the store boundary. Install paths are never project identity. */
const projectSessionRef = (storeRoot: string, session: SessionRef): SessionRef => normalizeSessionRef({
  ...session,
  cwd: projectCwd(storeRoot, session.cwd),
});

/** Repair records written by older builds so a stale install path cannot remain visible after the next read/write. */
const dropInstallCwd = <T extends { cwd?: string }>(storeRoot: string, record: T): T => {
  if (!isWithinStoreRoot(storeRoot, record.cwd)) return record;
  const { cwd: _ignoredInstallCwd, ...withoutCwd } = record;
  return withoutCwd as T;
};

/** Older runtimes serialized an absent optional process id as JSON null. Keep that
 * legacy representation from looking like a live owner during reconnect. */
const normalizeConnectionOwner = <T extends { ownerProcessId?: number | null }>(record: T): T => {
  if (record.ownerProcessId !== null) return record;
  const { ownerProcessId: _ignoredOwnerProcessId, ...withoutOwner } = record;
  return withoutOwner as T;
};

const normalizeStoredScopes = (storeRoot: string, state: StoreState): StoreState => {
  state.endpoints = Object.fromEntries(Object.entries(state.endpoints).map(([key, value]) => [key, dropInstallCwd(storeRoot, value)]));
  state.sessions = state.sessions.map((session) => dropInstallCwd(storeRoot, session));
  state.tasks = state.tasks.map((task) => dropInstallCwd(storeRoot, task));
  state.connectionClaims = state.connectionClaims.map((claim) => normalizeConnectionOwner(dropInstallCwd(storeRoot, claim)));
  state.connectionBindings = state.connectionBindings.map((binding) => normalizeConnectionOwner(dropInstallCwd(storeRoot, binding)));
  state.activeProviderTurns = state.activeProviderTurns.map((turn) => dropInstallCwd(storeRoot, turn));
  state.links = state.links.map((link) => ({
    ...link,
    a: dropInstallCwd(storeRoot, link.a),
    b: dropInstallCwd(storeRoot, link.b),
  }));
  return state;
};

const cursorKey = (handle: string, sessionId?: string, cwd?: string): string => {
  const normalizedHandle = normalizeHandle(handle);
  if (!sessionId) return normalizedHandle;
  const folder = normalizeSessionFolder(cwd);
  return folder ? JSON.stringify([normalizedHandle, folder, sessionId]) : normalizedHandle + "::" + sessionId;
};

const sameSession = (left: Pick<SessionRecord, "handle" | "sessionId" | "cwd">, right: Pick<SessionRecord, "handle" | "sessionId" | "cwd">): boolean =>
  normalizeHandle(left.handle) === normalizeHandle(right.handle)
  && left.sessionId === right.sessionId
  && normalizeSessionFolder(left.cwd) === normalizeSessionFolder(right.cwd);

type SessionRef = { handle: string; sessionId: string; cwd?: string };
const normalizeSessionRef = (session: SessionRef): SessionRef => ({
  handle: normalizeHandle(session.handle),
  sessionId: session.sessionId,
  ...(normalizeSessionFolder(session.cwd) ? { cwd: normalizeSessionFolder(session.cwd) } : {}),
});
const sameSessionRef = (a: SessionRef, b: SessionRef): boolean =>
  normalizeHandle(a.handle) === normalizeHandle(b.handle)
  && a.sessionId === b.sessionId
  && normalizeSessionFolder(a.cwd) === normalizeSessionFolder(b.cwd);

const KNOWN_PROVIDER_HANDLES: Readonly<Record<string, string>> = { "claude-code": "claude", claude: "claude", codex: "codex", opencode: "opencode" };

/** `claude-code` is addressed as `@claude`; unknown providers keep a safe slug of their own name. */
export function handleForProvider(provider: string): string {
  const key = normalizeHandle(provider);
  const known = KNOWN_PROVIDER_HANDLES[key];
  if (known) return known;
  return key.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "agent";
}

const LOCK_WAIT_MS = 3000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface LocalStoreDeps {
  now?: () => Date;
  /**
   * Determines whether an unbound provider claim still belongs to a live
   * provider host. Tests inject this so claim lifecycle behavior is
   * deterministic; production uses the local process table through
   * `process.kill(pid, 0)`.
   */
  isProcessAlive?: (pid: number) => boolean;
  /** Tests and embedded callers may choose a lower limit; the production maximum cannot be raised. */
  maxStateBytes?: number;
}

export function createLocalStore(root: string, deps: LocalStoreDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const isProcessAlive = deps.isProcessAlive ?? ((pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH/ENOENT mean the host is gone. Permission errors are treated as
      // alive because the process may exist outside this user's inspection
      // rights; cleanup must never turn uncertainty into data loss.
      const code = (error as NodeJS.ErrnoException).code;
      return code !== "ESRCH" && code !== "ENOENT";
    }
  });
  const statePath = join(root, "state.json");
  const lockPath = join(root, "state.lock");
  const maxStateBytes = Math.min(MAX_LOCAL_STATE_BYTES, Math.max(1, Math.floor(deps.maxStateBytes ?? MAX_LOCAL_STATE_BYTES)));

  function acquire(): string {
    mkdirSync(root, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    const nonce = randomUUID();
    const ownerName = `owner-${nonce}.json`;
    const pending = `${lockPath}.pending-${nonce}`;
    mkdirSync(pending);
    try {
      writeFileSync(join(pending, ownerName), JSON.stringify({ pid: process.pid, nonce }), { flag: "wx" });
      for (;;) {
        try {
          // Publish an already populated directory, avoiding an ownerless creation gap.
          renameSync(pending, lockPath);
          return ownerName;
        } catch (error) {
          if (!existsSync(lockPath)) {
            const code = (error as NodeJS.ErrnoException).code;
            // Windows can temporarily retain a directory handle after release.
            // Retry publication, never remove a directory or replace its owner.
            if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() > deadline) throw error;
            sleepSync(15);
            continue;
          }
          try {
            const files = readdirSync(lockPath);
            if (files.length === 1 && /^owner-[a-f0-9-]+\.json$/.test(files[0]!)) {
              const owner = JSON.parse(readFileSync(join(lockPath, files[0]!), "utf8"));
              if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                let dead = false;
                try { process.kill(owner.pid, 0); }
                catch (probeError) { dead = (probeError as NodeJS.ErrnoException).code === "ESRCH"; }
                if (dead) {
                  // Delete only the dead owner's unique file, never a replacement owner's lock.
                  rmSync(join(lockPath, files[0]!));
                  try { rmdirSync(lockPath); } catch { /* another owner published a populated lock */ }
                  continue;
                }
              }
            }
          } catch { /* disappearance or an unknown owner is not permission to steal */ }
          // Age is not evidence of a crash. Never remove another writer's lock.
          if (Date.now() > deadline) throw new Error(`The M9R local store is busy at ${lockPath}. Its lock was preserved; check the recorded owner before recovering a crashed writer.`);
          sleepSync(15);
        }
      }
    } finally {
      if (existsSync(pending)) rmSync(pending, { recursive: true, force: true });
    }
  }

  function readState(): StoreState {
    if (!existsSync(statePath)) return emptyState();
    const fileBytes = statSync(statePath).size;
    if (fileBytes > maxStateBytes) throw new LocalStateCapacityError(fileBytes, maxStateBytes);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(readFileSync(statePath, "utf8")); }
    catch { throw new Error(`M9R local state at ${statePath} is invalid. The original file was preserved; restore a verified backup before retrying.`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`M9R local state at ${statePath} is invalid; the original file was preserved.`);
    if (parsed.version !== 1) throw new Error(`M9R local state at ${statePath} has an unsupported version (${String(parsed.version)}). Use a compatible runtime; the original file was preserved.`);
    const defaults = emptyState();
    for (const [key, value] of Object.entries(defaults)) {
      const stored = parsed[key];
      if (stored === undefined) continue; // Fields added to version 1 remain backwards compatible.
      const valid = Array.isArray(value) ? Array.isArray(stored)
        : typeof value === "number" ? Number.isSafeInteger(stored) && Number(stored) >= 1
        : stored !== null && typeof stored === "object" && !Array.isArray(stored);
      if (!valid) throw new Error(`M9R local state at ${statePath} is invalid (${key}); the original file was preserved.`);
    }
    return normalizeStoredScopes(root, { ...defaults, ...parsed } as StoreState);
  }



  const pushEvent = (s: StoreState, event: Omit<EventRecord, "at">) => {
    s.events.push({ at: now().toISOString(), ...event });
    if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS);
  };

  /** Retry transient Windows sharing errors, but never replace atomic publication with an in-place copy. */
  function renameWithRetry(from: string, to: string): void {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { renameSync(from, to); return; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
    throw new Error(`M9R could not atomically publish local state at ${to}; the previous state and pending snapshot at ${from} were preserved.`);
  }

  /** Runs `fn` on the state under the lock and writes the result atomically. */
  function update<T>(fn: (state: StoreState) => T): T {
    const ownerName = acquire();
    try {
      const state = readState();
      const out = fn(state);
      const serialized = JSON.stringify(state);
      const serializedBytes = Buffer.byteLength(serialized, "utf8");
      if (serializedBytes > maxStateBytes) throw new LocalStateCapacityError(serializedBytes, maxStateBytes);
      const tmp = `${statePath}.tmp-${process.pid}`;
      writeFileSync(tmp, serialized, "utf8");
      renameWithRetry(tmp, statePath);
      return out;
    } finally {
      rmSync(join(lockPath, ownerName));
      try { rmdirSync(lockPath); } catch { /* never recursively remove a replacement lock */ }
    }
  }

  /**
   * Retire only unbound claims that cannot still represent a provider process.
   * Expiry is sufficient evidence for any scope; a live-process probe is used
   * only for the requested provider (and, during SessionStart, its exact
   * project/handle scope). Unknown or inaccessible owner PIDs are preserved so
   * provider-only discovery never turns uncertainty into a guessed binding.
   */
  function pruneStaleUnboundConnectionClaims(
    state: StoreState,
    at: Date,
    options: { provider?: string; handle?: string; cwd?: string; deadOnlySameScope?: boolean } = {},
  ): void {
    const provider = options.provider?.trim();
    const handle = options.handle ? normalizeHandle(options.handle) : undefined;
    const project = options.cwd === undefined ? undefined : normalizeSessionFolder(projectCwd(root, options.cwd));
    state.connectionClaims = state.connectionClaims.filter((candidate) => {
      if (candidate.bindingId) return true;
      const expiresAt = Date.parse(candidate.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= at.getTime()) return false;
      if (!provider || !sameConnectionProvider(candidate.provider, provider)) return true;
      if (options.deadOnlySameScope) {
        if (!handle || normalizeHandle(candidate.handle) !== handle
          || normalizeSessionFolder(projectCwd(root, candidate.cwd)) !== project) return true;
      }
      if (candidate.ownerProcessId === undefined) return true;
      return isProcessAlive(candidate.ownerProcessId);
    });
  }

  /**
   * Retire a prior durable binding only when a new session is starting in the
   * same provider/project scope and its recorded owner is demonstrably gone.
   * Durable bindings normally survive a worker restart, so this is deliberately
   * narrower than the unbound-claim sweep and never treats an unknown owner as
   * stale.
   */
  function pruneStaleBoundConnectionClaims(
    state: StoreState,
    at: Date,
    options: { provider: string; handle: string; cwd?: string; replacementProcessId: number },
  ): void {
    const provider = options.provider.trim();
    const handle = normalizeHandle(options.handle);
    const project = normalizeSessionFolder(projectCwd(root, options.cwd));
    const retiredBindingIds = new Set<string>();
    const retiredSessionIds = new Set<string>();
    state.connectionClaims = state.connectionClaims.filter((claim) => {
      if (!claim.bindingId
        || normalizeHandle(claim.handle) !== handle
        || !sameConnectionProvider(claim.provider, provider)
        || normalizeSessionFolder(projectCwd(root, claim.cwd)) !== project
        || claim.ownerProcessId === undefined
        || claim.ownerProcessId === options.replacementProcessId
        || isProcessAlive(claim.ownerProcessId)) return true;
      const binding = state.connectionBindings.find((candidate) => candidate.bindingId === claim.bindingId);
      if (!binding) return true;
      retiredBindingIds.add(binding.bindingId);
      retiredSessionIds.add(claim.sessionId);
      return false;
    });
    if (retiredBindingIds.size > 0) {
      state.connectionBindings = state.connectionBindings.filter((binding) => !retiredBindingIds.has(binding.bindingId));
      const retiredAt = at.toISOString();
      for (const identity of state.identities) {
        if (retiredSessionIds.has(identity.sessionId) && !identity.revokedAt) identity.revokedAt = retiredAt;
      }
    }
  }

  function applyTaskLifecycle(task: Task, patch: Partial<TaskLifecycle> & Pick<TaskLifecycle, "state">): void {
    task.lifecycle = {
      ...task.lifecycle,
      ...patch,
      ...(patch.error ? { error: redactSecrets(patch.error).slice(0, 240) } : {}),
    };
  }

  return {
    root,

    /** Read provider compatibility state without exposing any local credentials. */
    providerUpdateState(): ProviderUpdateState {
      const state = readState();
      return normalizeProviderUpdateState({ schemaVersion: 1, providers: state.providerUpdates });
    },

    /** Atomically publish provider compatibility state under the same lock as tasks and bindings. */
    saveProviderUpdateState(next: ProviderUpdateState): void {
      const normalized = normalizeProviderUpdateState(next);
      update((state) => { state.providerUpdates = normalized.providers; });
    },

    /** Adds a line to the activity log shown as "Recent" on the pill. */
    noteEvent(kind: EventRecord["kind"], text: string, taskId?: string): void {
      update((s) => { pushEvent(s, { kind, text, ...(taskId ? { taskId } : {}) }); });
    },

    registerEndpoint(input: { provider: string; sessionId?: string; cwd?: string; /** When it was really last active (from a file); default is now. */ seenAt?: string }): EndpointRecord {
      const handle = handleForProvider(input.provider);
      return update((s) => {
        const previous = s.endpoints[handle];
        const seen = input.seenAt ?? now().toISOString();
        const folder = normalizeSessionFolder(projectCwd(root, input.cwd));
        const record: EndpointRecord = { handle, provider: input.provider, sessionId: input.sessionId, cwd: folder || undefined, lastSeenAt: previous && Date.parse(previous.lastSeenAt) > Date.parse(seen) ? previous.lastSeenAt : seen };
        s.endpoints[handle] = record;
        let newSession = false;
        if (input.sessionId) {
          const at = input.seenAt ?? now().toISOString();
          const candidate = { handle, sessionId: input.sessionId, cwd: folder || undefined };
          const known = s.sessions.find((x) => sameSession(x, candidate));
          if (known) { if (Date.parse(at) > Date.parse(known.lastSeenAt)) known.lastSeenAt = at; if (folder) known.cwd = folder; }
          else {
            newSession = true;
            s.sessions.push({ handle, provider: input.provider, sessionId: input.sessionId, cwd: folder || undefined, firstSeenAt: at, lastSeenAt: at });
          }
          // Keep the list small: the 60 most recent sessions, nothing older than a week.
          const cutoff = now().getTime() - 7 * 86_400_000;
          s.sessions = s.sessions.filter((x) => Date.parse(x.lastSeenAt) >= cutoff).sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt)).slice(-60);
        }
        if (!previous) pushEvent(s, { kind: "agent.connected", handle, text: `@${handle} connected (${input.provider})` });
        else if (input.sessionId && newSession) pushEvent(s, { kind: "session.started", handle, text: `@${handle} started a new session` });
        return record;
      });
    },

    /** Sessions of one agent, most recently seen first. */
    sessionsFor(handle: string, cwd?: string): SessionRecord[] {
      const folder = cwd === undefined ? undefined : normalizeSessionFolder(projectCwd(root, cwd));
      return readState().sessions.filter((x) => normalizeHandle(x.handle) === normalizeHandle(handle) && (folder === undefined || normalizeSessionFolder(x.cwd) === folder)).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    },

    /**
     * Resolve the process recorded for one exact, active provider session.
     * This is intentionally not provider-wide discovery: stale, unowned,
     * expired, or internally inconsistent claims are not process evidence.
     */
    connectionProcessIdForSession(input: { provider: string; sessionId: string; cwd?: string }): number | undefined {
      const provider = input.provider.trim();
      const sessionId = input.sessionId.trim();
      if (!provider || !sessionId) return undefined;
      const handle = handleForProvider(provider);
      const folder = input.cwd === undefined ? undefined : normalizeSessionFolder(projectCwd(root, input.cwd));
      const state = readState();
      const identity = state.identities.some((candidate) => !candidate.revokedAt
        && candidate.sessionId === sessionId
        && normalizeHandle(candidate.handle) === normalizeHandle(handle)
        && sameConnectionProvider(candidate.provider, provider));
      if (!identity) return undefined;

      const nowMs = now().getTime();
      const claims = state.connectionClaims.filter((claim) => {
        if (claim.sessionId !== sessionId
          || normalizeHandle(claim.handle) !== normalizeHandle(handle)
          || !sameConnectionProvider(claim.provider, provider)
          || !validConnectionProcessId(claim.ownerProcessId)
          || !isProcessAlive(claim.ownerProcessId)) return false;
        if (folder !== undefined && normalizeSessionFolder(projectCwd(root, claim.cwd)) !== folder) return false;

        if (claim.bindingId) {
          return state.connectionBindings.some((binding) => binding.bindingId === claim.bindingId
            && binding.claimId === claim.claimId
            && binding.sessionId === sessionId
            && normalizeHandle(binding.handle) === normalizeHandle(handle)
            && sameConnectionProvider(binding.provider, provider)
            && binding.ownerProcessId === claim.ownerProcessId
            && (folder === undefined || normalizeSessionFolder(projectCwd(root, binding.cwd)) === folder));
        }
        return usableConnectionClaim(claim, nowMs, { provider, sessionId });
      });
      return claims.length === 1 ? claims[0]!.ownerProcessId : undefined;
    },

    /** Sessions that have a live M9R identity token. Delivery must never guess a provider session without one. */
    sessionsWithIdentity(handle: string, cwd?: string): SessionRecord[] {
      const folder = cwd === undefined ? undefined : normalizeSessionFolder(projectCwd(root, cwd));
      const state = readState();
      const live = new Set(state.identities.filter((identity) => !identity.revokedAt && normalizeHandle(identity.handle) === normalizeHandle(handle)).map((identity) => identity.sessionId));
      return state.sessions
        .filter((session) => normalizeHandle(session.handle) === normalizeHandle(handle) && live.has(session.sessionId) && (folder === undefined || normalizeSessionFolder(session.cwd) === folder))
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    },

    listEndpoints(): EndpointRecord[] {
      return Object.values(readState().endpoints);
    },

    /** Handles a mention may target: everyone this machine has seen, plus the well-known providers. */
    knownAliases(): string[] {
      const seen = Object.keys(readState().endpoints);
      return [...new Set([...seen, ...Object.values(KNOWN_PROVIDER_HANDLES)])];
    },

    /** Read a provider-neutral receipt without claiming or repeating the remote/desktop action. */
    inspectComputerOperation(input: ComputerOperationInput): StageOperationClaim | undefined {
      const record = readState().computerOperations.find((candidate) => candidate.key === computerOperationKey(input));
      if (!record) return undefined;
      if (record.fingerprint !== input.fingerprint) return { state: "conflict" };
      return { state: record.state === "running" ? "in_progress" : record.state, updatedAt: record.updatedAt };
    },

    /** Atomically claims one generic computer-use mutation before it reaches a non-stage backend. */
    claimComputerOperation(input: ComputerOperationInput): StageOperationClaim {
      const handle = normalizeHandle(input.handle);
      if (!handle || !input.sessionId || input.sessionId.length > 512
        || !input.targetId || input.targetId.length > 512
        || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.fingerprint)) {
        throw new Error("Invalid generic computer-use operation receipt identity.");
      }
      const key = computerOperationKey({ ...input, handle });
      return update((s) => {
        const existing = s.computerOperations.find((record) => record.key === key);
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) return { state: "conflict" };
          return { state: existing.state === "running" ? "in_progress" : existing.state, updatedAt: existing.updatedAt };
        }
        if (s.computerOperations.length >= MAX_COMPUTER_OPERATION_RECEIPTS) {
          throw new Error(`The generic computer-use receipt store is at capacity (${MAX_COMPUTER_OPERATION_RECEIPTS}); no input was sent.`);
        }
        const updatedAt = now().toISOString();
        s.computerOperations.push({ key, handle, sessionId: input.sessionId, targetId: input.targetId,
          operationId: input.operationId, fingerprint: input.fingerprint, state: "running", updatedAt });
        return { state: "claimed", updatedAt };
      });
    },

    /** Only a response explicitly proving no dispatch may release a generic receipt claim. */
    releaseComputerOperation(input: ComputerOperationInput): boolean {
      const key = computerOperationKey(input);
      return update((s) => {
        const record = s.computerOperations.find((candidate) => candidate.key === key);
        if (!record || record.fingerprint !== input.fingerprint || record.state !== "running") return false;
        s.computerOperations = s.computerOperations.filter((candidate) => candidate !== record);
        return true;
      });
    },

    /** A completed or ambiguous operation is terminal for replay purposes; recovery must observe, not redispatch. */
    settleComputerOperation(input: ComputerOperationInput & { state: "applied" | "uncertain" }): boolean {
      const key = computerOperationKey(input);
      return update((s) => {
        const record = s.computerOperations.find((candidate) => candidate.key === key);
        if (!record || record.fingerprint !== input.fingerprint) return false;
        if (record.state === input.state) return true;
        if (record.state !== "running") return false;
        record.state = input.state;
        record.updatedAt = now().toISOString();
        return true;
      });
    },

    /** Read a stage receipt without touching desktop state or claiming another operation. */
    inspectStageOperation(input: StageOperationInput): StageOperationClaim | undefined {
      const record = readState().stageOperations.find((candidate) => candidate.key === stageOperationKey(input));
      if (!record) return undefined;
      if (record.fingerprint !== input.fingerprint) return { state: "conflict" };
      return { state: record.state === "running" ? "in_progress" : record.state, updatedAt: record.updatedAt };
    },

    /** A typed pre-dispatch refusal may release its claim; ambiguous input never does. */
    releaseStageOperation(input: StageOperationInput): boolean {
      const key = stageOperationKey(input);
      return update((s) => {
        const record = s.stageOperations.find((candidate) => candidate.key === key);
        if (!record || record.fingerprint !== input.fingerprint || record.state !== "running") return false;
        s.stageOperations = s.stageOperations.filter((candidate) => candidate !== record);
        return true;
      });
    },

    /** Atomically claims an operation before OS input is sent; the same request cannot be replayed. */
    claimStageOperation(input: StageOperationInput): StageOperationClaim {
      const handle = normalizeHandle(input.handle);
      if (!handle || !input.sessionId || !/^T[0-9]{1,12}$/.test(input.taskId)
        || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.fingerprint)) {
        throw new Error("Invalid desktop-stage operation receipt identity.");
      }
      const key = stageOperationKey({ ...input, handle });
      return update((s) => {
        const existing = s.stageOperations.find((record) => record.key === key);
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) return { state: "conflict" };
          return {
            state: existing.state === "running" ? "in_progress" : existing.state,
            updatedAt: existing.updatedAt,
          };
        }
        if (!s.tasks.some((task) => task.id === input.taskId)) throw new Error("The task for this desktop-stage operation no longer exists.");
        if (s.stageOperations.length >= MAX_STAGE_OPERATION_RECEIPTS) {
          throw new Error(`The desktop-stage operation receipt store is at capacity (${MAX_STAGE_OPERATION_RECEIPTS}); no input was sent.`);
        }
        const updatedAt = now().toISOString();
        s.stageOperations.push({ key, handle, sessionId: input.sessionId, taskId: input.taskId,
          fingerprint: input.fingerprint, state: "running", updatedAt });
        return { state: "claimed", updatedAt };
      });
    },

    /** Records whether a claimed input returned or became ambiguous after dispatch. */
    settleStageOperation(input: StageOperationInput & { state: "applied" | "uncertain" }): boolean {
      const key = stageOperationKey(input);
      return update((s) => {
        const record = s.stageOperations.find((candidate) => candidate.key === key);
        if (!record || record.fingerprint !== input.fingerprint) return false;
        if (record.state === input.state) return true;
        if (record.state !== "running") return false;
        record.state = input.state;
        record.updatedAt = now().toISOString();
        return true;
      });
    },

    /**
     * Persist one phase boundary on the task itself. This is deliberately best-effort at the
     * stage boundary: a timing write must never turn a successful desktop action into a failed
     * action, but malformed events are rejected rather than being allowed into state.json.
     */
    recordStageTiming(taskId: string, event: StageTimingEvent): boolean {
      if (!/^T[0-9]{1,12}$/.test(taskId)
        || !["queue_wait", "prepare", "launch", "action", "close", "stop", "sdk-load", "host-connect", "runtime-acquire", "session-start", "cursor-motion"].includes(event.phase)
        || !["ok", "error"].includes(event.status)
        || !Number.isFinite(event.durationMs) || event.durationMs < 0
        || Number.isNaN(Date.parse(event.startedAt)) || Number.isNaN(Date.parse(event.endedAt))) return false;
      if (event.operationId !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(event.operationId)) return false;
      const detail = event.detail === undefined ? undefined : redactSecrets(event.detail).slice(0, MAX_STAGE_TIMING_DETAIL_CHARS);
      const stored: StageTimingEvent = {
        phase: event.phase,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationMs: Math.round(event.durationMs),
        status: event.status,
        ...(event.operationId ? { operationId: event.operationId } : {}),
        ...(detail ? { detail } : {}),
      };
      return update((s) => {
        const task = s.tasks.find((candidate) => candidate.id === taskId);
        if (!task) return false;
        const prior = Array.isArray(task.stageTiming) ? task.stageTiming : [];
        task.stageTiming = [...prior, stored].slice(-MAX_STAGE_TIMING_EVENTS_PER_TASK);
        return true;
      });
    },

    /** Same idempotency key for the same recipient returns the existing task, so a repeated send delivers once. */
    addTask(input: NewTaskInput): { task: Task; created: boolean } {
      const scopedCwd = projectCwd(root, input.cwd);
      const { cwd: _ignoredInstallCwd, ...inputWithoutCwd } = input;
      const normalizedInput = {
        ...inputWithoutCwd,
        ...(scopedCwd ? { cwd: scopedCwd } : {}),
        from: normalizeHandle(input.from),
        to: normalizeHandle(input.to),
      };
      return update((s) => {
        const existing = findByIdempotencyKey(s.tasks, normalizedInput.to, normalizedInput.idempotencyKey);
        // Idempotency dedup exists to collapse an accidental double-submit (a retried network
        // call sending the identical request twice within moments), not to permanently block a
        // deliberate resend of the same wording later -- live bug, 2026-10-18: pasting text
        // identical to an earlier task (the idempotency key hashes session+target+exact text,
        // with no bound) silently reused the old, already-resolved task forever instead of
        // creating a fresh one, so the paste appeared to do nothing live. An existing match only
        // suppresses creation while it is still within the same staleness bound used for
        // in-flight delivery elsewhere (inboxMaxAgeMs) and not yet resolved; past that, or once
        // resolved, a repeated send is a new request and gets a new task.
        if (existing && !existing.resultSummary && now().getTime() - Date.parse(existing.createdAt) <= inboxMaxAgeMs()) {
          return { task: existing, created: false };
        }
        // Retire aged or over-budget resolved work before admitting a task. Anything still in flight, awaiting
        // approval, undelivered, or unread is retained, so a full backlog becomes an explicit send failure.
        const retainedTasks = pruneTasks(s.tasks, {
          maxCount: MAX_STORED_TASKS - 1,
          maxAgeMs: RESOLVED_TASK_RETENTION_MS,
          now: now().getTime(),
        });
        if (retainedTasks.length >= MAX_STORED_TASKS) throw new LocalTaskCapacityError(retainedTasks.length);
        s.tasks = retainedTasks;
        const retainedTaskIds = new Set(retainedTasks.map((task) => task.id));
        s.stageOperations = s.stageOperations.filter((operation) => retainedTaskIds.has(operation.taskId));
        const seq = (s.nextSeq[normalizedInput.to] ?? 0) + 1;
        s.nextSeq[normalizedInput.to] = seq;
        const id = `T${s.nextTaskNo}`;
        s.nextTaskNo += 1;
        const sameRoom = normalizedInput.origin === "agent_initiated" && normalizedInput.standingRuleApplies === undefined && String(normalizedInput.from).startsWith("web-") && String(normalizedInput.to).startsWith("web-");
        const rule = sameRoom ? undefined : normalizedInput.origin === "agent_initiated" && normalizedInput.standingRuleApplies === undefined ? ruleCovers(s.rules, { from: normalizedInput.from, to: normalizedInput.to, goal: normalizedInput.goal }, now()) : undefined;
        const task = newTask({ ...normalizedInput, standingRuleApplies: normalizedInput.standingRuleApplies ?? (sameRoom || !!rule) }, { id, seq }, now().toISOString());
        s.tasks.push(task);
        if (rule) pushEvent(s, { kind: "task.approved", taskId: id, handle: task.to, text: `${id} approved by standing rule ${rule.id}` });
        pushEvent(s, { kind: "task.created", taskId: id, handle: task.to, text: `@${task.from} to @${task.to}: ${task.goal.slice(0, 120)}` });
        return { task, created: true };
      });
    },

    /** Records that these tasks were shown to their target; the first time only. */
    markDelivered(ids: readonly string[], sessionId?: string): void {
      if (ids.length === 0) return;
      update((s) => {
        for (const id of ids) {
          const t = s.tasks.find((x) => x.id === id);
          if (!t) continue;
          const targetSession = t.targetSession;
          if (targetSession && sessionId && targetSession !== sessionId) continue;
          const firstDelivery = !t.deliveredAt;
          if (firstDelivery) t.deliveredAt = now().toISOString();
          if (firstDelivery) t.deliverySource = "push";
          // A sender-pinned session is authoritative. Repair older rows where a
          // hook's incidental deliverySession disagreed with that target.
          if (sessionId && (!targetSession || targetSession === sessionId)) t.deliveredSession = targetSession ?? sessionId;
          recordTaskReceipt(t, {
            state: "provider_received",
            at: now().toISOString(),
            source: "prompt",
            ...(sessionId ? { sessionId: targetSession ?? sessionId } : {}),
          });
          if (firstDelivery) pushEvent(s, { kind: "task.delivered", taskId: id, handle: t.to, text: `@${t.to} received ${id}` });
        }
      });
    },

    /** Tasks shown to this agent's session that have no answer yet: what its next finished turn is (probably) the answer to. */
    awaitingAnswerFrom(handle: string, sessionId: string | undefined, withinMs = 60 * 60_000): Task[] {
      const normalizedHandle = normalizeHandle(handle);
      const cutoff = now().getTime() - withinMs;
      return readState().tasks.filter((t) => normalizeHandle(t.to) === normalizedHandle && t.deliveredAt && !t.resultSummary && (!(t.targetSession ?? t.deliveredSession) || (t.targetSession ?? t.deliveredSession) === sessionId) && Date.parse(t.deliveredAt) >= cutoff);
    },

    setAnswerPushed(id: string): void {
      update((s) => { const t = s.tasks.find((x) => x.id === id); if (t) t.answerPushedAt = now().toISOString(); });
    },

    /** Issues (or, for the same session, re-issues) an identity token. Old tokens for the SAME session are revoked, so a
     * session that starts again never has two live tokens. Capped: the 200 most recent stay, so the store cannot grow forever. */
    issueIdentity(handle: string, provider: string, sessionId: string): IdentityToken {
      return update((s) => {
        const at = now().toISOString();
        for (const t of s.identities) if (t.sessionId === sessionId && !t.revokedAt) t.revokedAt = at;
        const issued = issueIdentity(normalizeHandle(handle), provider, sessionId, at);
        s.identities = [...s.identities, issued].slice(-200);
        return issued;
      });
    },

    /** Checks a presented token; does not mutate. */
    verifyIdentity(token: string, claimedSessionId?: string): VerifiedIdentity | null {
      return verifyToken(readState().identities, token, claimedSessionId);
    },

    /** Return the already-issued token for one authenticated session without rotating its other tools' credentials. */
    identityTokenFor(handle: string, sessionId: string): string | null {
      const identity = readState().identities.find((item) => !item.revokedAt && item.sessionId === sessionId && normalizeHandle(item.handle) === normalizeHandle(handle));
      return identity?.token ?? null;
    },

    /** Distinguishes a session that never had an identity from one whose identity was explicitly revoked. */
    identityWasRevoked(handle: string, sessionId: string): boolean {
      const records = readState().identities.filter((item) => item.sessionId === sessionId && normalizeHandle(item.handle) === normalizeHandle(handle));
      return records.length > 0 && records.every((item) => !!item.revokedAt);
    },

    /** Bind direct delivery to one verified provider session before the provider receives its plain task. */
    bindTaskToSession(id: string, token: string): boolean {
      return update((s) => {
        const identity = s.identities.find((item) => item.token === token && !item.revokedAt);
        const task = s.tasks.find((item) => item.id === id);
        if (!identity || !task || task.resultSummary || !canQueue(task) || normalizeHandle(task.to) !== normalizeHandle(identity.handle)) return false;
        const owner = task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId;
        if (owner && owner !== identity.sessionId) return false;
        // Same staleness bound as sessionHasUnfinishedDelivery (task-delivery-pump.ts), and for the
        // identical reason: a verbatim retry (the common case -- resend the exact same wording
        // after a failure) must not stay blocked forever behind an original attempt whose delivery
        // record never got finalized. Confirmed live in production state (T248/T249, 2026-10-17).
        const maxAge = inboxMaxAgeMs();
        const occupiedAt = now().getTime();
        const occupied = s.tasks.some((other) => other.id !== id && normalizeHandle(other.to) === normalizeHandle(identity.handle)
          && !other.resultSummary && other.goal === task.goal
          && (other.targetSession ?? other.deliveredSession ?? other.delivery?.threadId) === identity.sessionId
          && ["sending", "queued", "uncertain"].includes(other.delivery?.state ?? "")
          && occupiedAt - Date.parse(other.createdAt) <= maxAge);
        if (occupied) return false;
        task.deliveredSession = identity.sessionId;
        if (task.delivery) task.delivery.threadId = identity.sessionId;
        return true;
      });
    },

    /** Atomically assign one explicitly deferred owner task to the configured resident provider worker. */
    claimProviderDelivery(id: string, token: string, expected: { handle: string; provider: string; cwd: string }): Task | undefined {
      return update((s) => {
        const identity = s.identities.find((item) => item.token === token && !item.revokedAt);
        const task = s.tasks.find((item) => item.id === id);
        const handle = normalizeHandle(expected.handle);
        const provider = expected.provider.trim().toLowerCase();
        const folder = normCwd(expected.cwd);
        if (!identity || !task || !folder
          || normalizeHandle(identity.handle) !== handle
          || identity.provider.trim().toLowerCase() !== provider
          || normalizeHandle(task.to) !== handle
          || normalizeHandle(task.from) !== "you"
          || task.origin !== "human_typed"
          || !canQueue(task)
          || task.delivery?.state !== "deferred"
          || task.receipt?.state === "canceled"
          || task.resultSummary || task.deliveredAt || task.deliveredSession || task.targetSession
          || task.delivery.threadId
          || (task.cwd && normCwd(task.cwd) !== folder)
          || !isFreshInboxTask(task.createdAt, now().getTime(), inboxMaxAgeMs())) return undefined;

        const claimedAt = now().toISOString();
        task.deliveredSession = identity.sessionId;
        task.delivery = {
          ...task.delivery,
          state: "sending",
          attempts: task.delivery.attempts + 1,
          threadId: identity.sessionId,
          claimedAt,
          correlation: "internal-context",
          error: undefined,
        };
        recordTaskReceipt(task, {
          state: "dispatched",
          at: claimedAt,
          attempt: task.delivery.attempts,
          source: "provider-transport",
          sessionId: identity.sessionId,
        });
        return task;
      });
    },

    /** Ends a session's token early (the person revoked it from the pill, or the session closed). */
    revokeIdentity(sessionId: string): void {
      update((s) => {
        const at = now().toISOString();
        for (const t of s.identities) if (t.sessionId === sessionId && !t.revokedAt) t.revokedAt = at;
        // A revoked provider session can never authenticate an MCP transport again. Remove its
        // private connection records so a later provider process cannot inherit stale ownership.
        s.connectionClaims = s.connectionClaims.filter((claim) => claim.sessionId !== sessionId);
        s.connectionBindings = s.connectionBindings.filter((binding) => binding.sessionId !== sessionId);
      });
    },

    /**
     * Issues one private provider-session claim. Repeated SessionStart events for the same
     * session are idempotent and refresh the provider parent PID, so an MCP worker can be
     * replaced without rotating a user-facing credential or selecting a different session.
     */
    issueConnectionClaim(input: ConnectionClaimInput): ConnectionClaim {
      const handle = normalizeHandle(input.handle);
      const provider = input.provider.trim();
      if (!handle || !provider || !input.sessionId) throw new Error("A connection claim needs a provider, handle, and session.");
      if (input.ownerProcessId !== undefined && !validConnectionProcessId(input.ownerProcessId)) throw new Error("A connection claim process id must be a positive integer.");
      return update((s) => {
        const at = now();
        const cwd = projectCwd(root, input.cwd);
        const activeIdentity = s.identities.find((identity) => !identity.revokedAt
          && identity.sessionId === input.sessionId
          && normalizeHandle(identity.handle) === handle
          && sameConnectionProvider(identity.provider, provider));
        if (!activeIdentity) throw new Error("Cannot issue a connection claim without an active provider identity.");

        const existing = s.connectionClaims.find((claim) => claim.sessionId === input.sessionId
          && normalizeHandle(claim.handle) === handle
          && sameConnectionProvider(claim.provider, provider));
        if (existing) {
          existing.cwd = cwd;
          existing.ownerProcessId = input.ownerProcessId;
          existing.expiresAt = new Date(at.getTime() + CONNECTION_CLAIM_TTL_MS).toISOString();
          const bound = existing.bindingId ? s.connectionBindings.find((candidate) => candidate.bindingId === existing.bindingId) : undefined;
          if (bound) {
            bound.cwd = existing.cwd;
            bound.ownerProcessId = existing.ownerProcessId;
          }
          return existing;
        }

        if (input.ownerProcessId !== undefined) {
          pruneStaleBoundConnectionClaims(s, at, {
            provider,
            handle,
            cwd,
            replacementProcessId: input.ownerProcessId,
          });
        }

        const claim: ConnectionClaim = {
          claimId: newConnectionId(),
          handle,
          provider,
          sessionId: input.sessionId,
          ...(cwd ? { cwd } : {}),
          ...(input.ownerProcessId !== undefined ? { ownerProcessId: input.ownerProcessId } : {}),
          issuedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + CONNECTION_CLAIM_TTL_MS).toISOString(),
        };
        // A new SessionStart may safely retire only claims that are already
        // expired or whose recorded provider host is demonstrably dead. Live
        // competing sessions remain, so provider-only discovery still fails
        // closed instead of silently choosing a winner.
        pruneStaleUnboundConnectionClaims(s, at, { provider, handle, cwd: input.cwd, deadOnlySameScope: true });
        s.connectionClaims = [...s.connectionClaims, claim].slice(-MAX_CONNECTION_RECORDS);
        return claim;
      });
    },

    /**
     * Records which exact provider conversation is currently executing a turn.
     * A provider process may host many conversations, so its PID alone is not
     * a conversation selector. This is called only from a trusted prompt hook
     * after that exact session has an active identity and private claim.
     */
    beginProviderTurn(input: { provider: string; sessionId: string; turnId?: string; cwd?: string; processId: number }): boolean {
      const provider = input.provider.trim();
      const sessionId = input.sessionId.trim();
      const handle = handleForProvider(provider);
      const turnId = input.turnId?.trim();
      if (!provider || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)
        || (turnId !== undefined && (!turnId || turnId.length > 256 || /[\u0000-\u001f\u007f]/.test(turnId)))
        || !validConnectionProcessId(input.processId)) return false;
      return update((s) => {
        const at = now();
        const cwd = normalizeSessionFolder(projectCwd(root, input.cwd));
        const activeIdentity = s.identities.some((identity) => !identity.revokedAt
          && identity.sessionId === sessionId
          && normalizeHandle(identity.handle) === handle
          && sameConnectionProvider(identity.provider, provider));
        const claim = s.connectionClaims.find((candidate) => candidate.sessionId === sessionId
          && normalizeHandle(candidate.handle) === handle
          && sameConnectionProvider(candidate.provider, provider)
          && candidate.ownerProcessId === input.processId
          && (!cwd || normalizeSessionFolder(candidate.cwd) === cwd));
        if (!activeIdentity || !claim) return false;

        // The same conversation can be reopened by a replacement process. The
        // newest trusted hook owns that exact session; distinct sessions in the
        // same PID are intentionally retained so concurrent turns fail closed.
        s.activeProviderTurns = s.activeProviderTurns.filter((turn) => !(turn.sessionId === sessionId
          && normalizeHandle(turn.handle) === handle
          && sameConnectionProvider(turn.provider, provider)));
        s.activeProviderTurns.push({
          handle,
          provider,
          sessionId,
          ...(turnId ? { turnId } : {}),
          ...(cwd ? { cwd } : {}),
          processId: input.processId,
          startedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + PROVIDER_TURN_TTL_MS).toISOString(),
        });
        if (s.activeProviderTurns.length > MAX_CONNECTION_RECORDS) {
          s.activeProviderTurns = s.activeProviderTurns.slice(-MAX_CONNECTION_RECORDS);
        }
        return true;
      });
    },

    /** Ends only the exact turn named by a trusted provider Stop event. */
    endProviderTurn(input: { provider: string; sessionId: string; turnId?: string; processId: number }): void {
      const provider = input.provider.trim();
      const handle = handleForProvider(provider);
      const turnId = input.turnId?.trim();
      if (!provider || !input.sessionId || !validConnectionProcessId(input.processId)
        || (input.turnId !== undefined && (!turnId || turnId.length > 256 || /[\u0000-\u001f\u007f]/.test(turnId)))) return;
      update((s) => {
        s.activeProviderTurns = s.activeProviderTurns.filter((turn) => !(turn.sessionId === input.sessionId
          && turn.processId === input.processId
          && (turnId === undefined || turn.turnId === turnId)
          && normalizeHandle(turn.handle) === handle
          && sameConnectionProvider(turn.provider, provider)));
      });
    },

    /**
     * Resolves and binds the single currently active provider turn for a host.
     * It never chooses by most-recent timestamp: overlapping turns on the same
     * shared MCP host are ambiguous until the exact Stop hook closes one.
     */
    bindActiveProviderTurn(expected: { provider: string; processId: number }):
      | { status: "none" | "ambiguous" | "unavailable" }
      | { status: "resolved"; binding: ConnectionBinding } {
      const provider = expected.provider.trim();
      if (!provider || !validConnectionProcessId(expected.processId)) return { status: "unavailable" };
      return update((s) => {
        const at = now();
        const atMs = at.getTime();
        s.activeProviderTurns = s.activeProviderTurns.filter((turn) => {
          const expiresAt = Date.parse(turn.expiresAt);
          return Number.isFinite(expiresAt) && expiresAt > atMs && isProcessAlive(turn.processId);
        });
        const turns = s.activeProviderTurns.filter((turn) => turn.processId === expected.processId
          && sameConnectionProvider(turn.provider, provider));
        if (turns.length === 0) return { status: "none" } as const;
        if (turns.length !== 1) return { status: "ambiguous" } as const;

        const turn = turns[0]!;
        const identity = s.identities.find((candidate) => !candidate.revokedAt
          && candidate.sessionId === turn.sessionId
          && normalizeHandle(candidate.handle) === normalizeHandle(turn.handle)
          && sameConnectionProvider(candidate.provider, turn.provider));
        const claim = s.connectionClaims.find((candidate) => candidate.sessionId === turn.sessionId
          && normalizeHandle(candidate.handle) === normalizeHandle(turn.handle)
          && sameConnectionProvider(candidate.provider, turn.provider)
          && candidate.ownerProcessId === expected.processId);
        if (!identity || !claim) return { status: "unavailable" } as const;

        let binding = claim.bindingId
          ? s.connectionBindings.find((candidate) => candidate.bindingId === claim.bindingId
            && candidate.claimId === claim.claimId
            && candidate.sessionId === turn.sessionId
            && normalizeHandle(candidate.handle) === normalizeHandle(turn.handle)
            && sameConnectionProvider(candidate.provider, turn.provider))
          : undefined;
        if (claim.bindingId && !binding) return { status: "unavailable" } as const;
        if (!binding) {
          binding = {
            bindingId: newConnectionId(),
            claimId: claim.claimId,
            handle: claim.handle,
            provider: claim.provider,
            sessionId: claim.sessionId,
            ...(claim.cwd ? { cwd: claim.cwd } : {}),
            ownerProcessId: expected.processId,
            boundAt: at.toISOString(),
          };
          claim.bindingId = binding.bindingId;
          claim.boundAt = binding.boundAt;
          s.connectionBindings = [...s.connectionBindings, binding].slice(-MAX_CONNECTION_RECORDS);
        }
        turn.expiresAt = new Date(atMs + PROVIDER_TURN_TTL_MS).toISOString();
        return { status: "resolved", binding } as const;
      });
    },

    /** Binds an explicit private claim. Once bound, worker restarts reuse the same binding idempotently. */
    bindConnectionClaim(claimId: string, expected: BindConnectionInput = {}): ConnectionBinding | null {
      return update((s) => {
        const claim = s.connectionClaims.find((candidate) => candidate.claimId === claimId);
        if (!claim) return null;
        const existing = claim.bindingId ? s.connectionBindings.find((candidate) => candidate.bindingId === claim.bindingId) : undefined;
        if (existing) {
          const identity = s.identities.find((candidate) => !candidate.revokedAt && candidate.sessionId === existing.sessionId
            && normalizeHandle(candidate.handle) === normalizeHandle(existing.handle)
            && sameConnectionProvider(candidate.provider, existing.provider));
          return identity ? existing : null;
        }
        if (!usableConnectionClaim(claim, now().getTime(), expected)) return null;
        const binding: ConnectionBinding = {
          bindingId: newConnectionId(),
          claimId: claim.claimId,
          handle: claim.handle,
          provider: claim.provider,
          sessionId: claim.sessionId,
          ...(claim.cwd ? { cwd: claim.cwd } : {}),
          ...(claim.ownerProcessId !== undefined ? { ownerProcessId: claim.ownerProcessId } : {}),
          boundAt: now().toISOString(),
        };
        claim.bindingId = binding.bindingId;
        claim.boundAt = binding.boundAt;
        s.connectionBindings = [...s.connectionBindings.filter((candidate) => candidate.bindingId !== binding.bindingId), binding].slice(-MAX_CONNECTION_RECORDS);
        return binding;
      });
    },

    /**
     * Resolves the one claim owned by a provider parent process. Multiple matching sessions
     * fail closed; M9R must never guess after a stale or duplicated runtime is present.
     */
    bindConnectionForProcess(expected: BindConnectionInput): ConnectionBinding | null {
      return update((s) => {
        const provider = expected.provider?.trim();
        const processId = expected.processId;
        const at = now();
        const active = (sessionId: string, handle: string, claimProvider: string) => s.identities.some((identity) => !identity.revokedAt
          && identity.sessionId === sessionId
          && normalizeHandle(identity.handle) === normalizeHandle(handle)
          && sameConnectionProvider(identity.provider, claimProvider));
        const createBinding = (claim: ConnectionClaim): ConnectionBinding => {
          const binding: ConnectionBinding = {
            bindingId: newConnectionId(),
            claimId: claim.claimId,
            handle: claim.handle,
            provider: claim.provider,
            sessionId: claim.sessionId,
            ...(claim.cwd ? { cwd: claim.cwd } : {}),
            ...(claim.ownerProcessId !== undefined ? { ownerProcessId: claim.ownerProcessId } : {}),
            boundAt: at.toISOString(),
          };
          claim.bindingId = binding.bindingId;
          claim.boundAt = binding.boundAt;
          s.connectionBindings = [...s.connectionBindings, binding].slice(-MAX_CONNECTION_RECORDS);
          return binding;
        };

        // A fresh provider session must take precedence over a durable binding
        // left by an older session whose owner has exited.  Without this
        // guard, the restart-recovery branch below can reassign the old
        // binding to the new process before the new claim is considered,
        // making the provider silently operate as the previous session.
        const exactProcessClaims = processId === undefined
          ? []
          : s.connectionClaims.filter((claim) => !claim.bindingId
            && claim.ownerProcessId === processId
            && usableConnectionClaim(claim, at.getTime(), expected)
            && active(claim.sessionId, claim.handle, claim.provider));
        if (exactProcessClaims.length > 1) return null;
        if (exactProcessClaims.length === 1) {
          const binding = createBinding(exactProcessClaims[0]!);
          pruneStaleUnboundConnectionClaims(s, at, { provider });
          return binding;
        }

        // A provider MCP worker can outlive the parent process that issued its
        // claim. Keep a sole active claim usable across that restart, while
        // preserving fail-closed behavior when more than one live session is
        // eligible or the previous owner is still demonstrably alive.
        const activeBindings = s.connectionBindings.filter((binding) => {
          if (provider && !sameConnectionProvider(binding.provider, provider)) return false;
          if (expected.sessionId && binding.sessionId !== expected.sessionId) return false;
          if (expected.cwd !== undefined && !sameConnectionCwd(binding.cwd, expected.cwd)) return false;
          const claim = s.connectionClaims.find((candidate) => candidate.claimId === binding.claimId);
          return claim?.bindingId === binding.bindingId && active(binding.sessionId, binding.handle, binding.provider);
        });
        if (activeBindings.length > 1) {
          // A provider process can survive a compaction/reconnect boundary while
          // the old durable binding remains in state.json. If the current
          // provider endpoint has published exactly one fresh session heartbeat,
          // that heartbeat is stronger evidence than an old active identity. We
          // may retire duplicates only when every candidate is the same provider,
          // handle/project, and process lineage; two genuinely live sessions or
          // different owners remain fail-closed.
          const scope = activeBindings[0]!;
          const sameLineage = provider !== undefined
            && activeBindings.every((binding) => sameConnectionProvider(binding.provider, scope.provider)
              && normalizeHandle(binding.handle) === normalizeHandle(scope.handle)
              && normalizeSessionFolder(projectCwd(root, binding.cwd)) === normalizeSessionFolder(projectCwd(root, scope.cwd))
              && processId !== undefined
              && (binding.ownerProcessId === undefined || binding.ownerProcessId === processId || !isProcessAlive(binding.ownerProcessId)));
          if (sameLineage) {
            const freshSessionIds = new Set(Object.values(s.endpoints)
              .filter((endpoint) => endpoint.sessionId
                && sameConnectionProvider(endpoint.provider, scope.provider)
                && normalizeHandle(endpoint.handle) === normalizeHandle(scope.handle)
                && normalizeSessionFolder(projectCwd(root, endpoint.cwd)) === normalizeSessionFolder(projectCwd(root, scope.cwd))
                && Number.isFinite(Date.parse(endpoint.lastSeenAt))
                && at.getTime() - Date.parse(endpoint.lastSeenAt) <= CONNECTION_CLAIM_TTL_MS)
              .map((endpoint) => endpoint.sessionId!));
            if (freshSessionIds.size === 1) {
              const winner = activeBindings.find((binding) => freshSessionIds.has(binding.sessionId));
              if (winner) {
                const retiredBindingIds = new Set(activeBindings.filter((binding) => binding !== winner).map((binding) => binding.bindingId));
                const retiredClaimIds = new Set(activeBindings.filter((binding) => binding !== winner).map((binding) => binding.claimId));
                s.connectionBindings = s.connectionBindings.filter((binding) => !retiredBindingIds.has(binding.bindingId));
                s.connectionClaims = s.connectionClaims.filter((claim) => !retiredClaimIds.has(claim.claimId));
                const winnerClaim = s.connectionClaims.find((claim) => claim.claimId === winner.claimId && claim.bindingId === winner.bindingId);
                if (!winnerClaim) return null;
                winner.ownerProcessId = processId;
                winnerClaim.ownerProcessId = processId;
                return winner;
              }
            }
          }
          return null;
        }
        if (activeBindings.length === 1) {
          const binding = activeBindings[0]!;
          if (processId === undefined || binding.ownerProcessId === processId) return binding;
          if (binding.ownerProcessId == null || !isProcessAlive(binding.ownerProcessId)) {
            const claim = s.connectionClaims.find((candidate) => candidate.claimId === binding.claimId && candidate.bindingId === binding.bindingId);
            if (!claim) return null;
            claim.ownerProcessId = processId;
            binding.ownerProcessId = processId;
            return binding;
          }
          return null;
        }

        const providerOnlyExpected: BindConnectionInput = {
          ...(provider ? { provider } : {}),
          ...(expected.sessionId ? { sessionId: expected.sessionId } : {}),
          ...(expected.cwd !== undefined ? { cwd: expected.cwd } : {}),
        };
        const activeClaims = s.connectionClaims.filter((claim) => !claim.bindingId
          && usableConnectionClaim(claim, at.getTime(), providerOnlyExpected)
          && active(claim.sessionId, claim.handle, claim.provider));
        if (activeClaims.length === 1) {
          const claim = activeClaims[0]!;
          const ownerCanBeAdopted = processId === undefined
            || claim.ownerProcessId == null
            || claim.ownerProcessId === processId
            || !isProcessAlive(claim.ownerProcessId);
          if (ownerCanBeAdopted) {
            if (processId !== undefined) claim.ownerProcessId = processId;
            return createBinding(claim);
          }
        }

        // This is also the recovery path for an already-running provider MCP
        // process. Do not require another SessionStart just to remove a claim
        // whose owner is demonstrably gone; live competitors remain fail-closed.
        pruneStaleUnboundConnectionClaims(s, at, { provider });
        const matchingBindings = s.connectionBindings.filter((binding) => (!provider || sameConnectionProvider(binding.provider, provider))
          && (processId === undefined || binding.ownerProcessId === processId)
          && (expected.cwd === undefined || sameConnectionCwd(binding.cwd, expected.cwd))
          && active(binding.sessionId, binding.handle, binding.provider));
        if (matchingBindings.length === 1) return matchingBindings[0];
        if (matchingBindings.length > 1) return null;

        const candidates = s.connectionClaims.filter((claim) => usableConnectionClaim(claim, at.getTime(), expected)
          && active(claim.sessionId, claim.handle, claim.provider));
        if (candidates.length !== 1) return null;
        return createBinding(candidates[0]!);
      });
    },

    /**
     * Recover the one provider session already known in this project when a
     * provider-owned hook/plugin did not republish its claim after an update
     * or process replacement. This is deliberately narrower than discovery:
     * it requires one recoverable session, one provider, one project, and (when
     * supplied) one explicit session id. Ambiguous or explicitly revoked
     * sessions remain fail-closed. Identity and claim values stay private.
     */
    recoverProviderConnection(input: {
      provider: string;
      cwd?: string;
      sessionId?: string;
      processId?: number;
    }): ConnectionBinding | null {
      const provider = input.provider.trim();
      if (!provider) return null;
      const handle = handleForProvider(provider);
      const folder = input.cwd === undefined ? undefined : normalizeSessionFolder(projectCwd(root, input.cwd));
      const requestedSession = input.sessionId?.trim() || undefined;
      const at = now().getTime();
      const sessions = readState().sessions.filter((session) => {
        const seenAt = Date.parse(session.lastSeenAt);
        return normalizeHandle(session.handle) === handle
          && sameConnectionProvider(session.provider, provider)
          && (folder === undefined || normalizeSessionFolder(session.cwd) === folder)
          && (!requestedSession || session.sessionId === requestedSession)
          && Number.isFinite(seenAt)
          && seenAt <= at
          && at - seenAt <= PROVIDER_SESSION_RECOVERY_TTL_MS;
      });
      if (sessions.length !== 1) return null;
      const session = sessions[0]!;
      if (this.identityWasRevoked(handle, session.sessionId)) return null;

      // Each operation is atomic and idempotent. A racing worker either sees
      // the identity/claim just published or fails the same one-candidate
      // check; it never receives a guessed token or a second assignment.
      this.registerEndpoint({ provider, sessionId: session.sessionId, cwd: folder, seenAt: new Date(at).toISOString() });
      if (!this.identityTokenFor(handle, session.sessionId)) this.issueIdentity(handle, provider, session.sessionId);
      try {
        this.issueConnectionClaim({ handle, provider, sessionId: session.sessionId, cwd: folder, ownerProcessId: input.processId });
      } catch {
        return null;
      }
      return this.bindConnectionForProcess({ provider, processId: input.processId });
    },

    /**
     * Reconcile a session discovered live by a provider adapter.
     *
     * `recoverProviderConnection` intentionally has a bounded last-seen
     * window because it may have to choose a session from local state. A
     * provider adapter that has just observed an exact live session has
     * stronger evidence: it supplies the provider's session id, project, and
     * (when available) current provider process. That evidence must not expire
     * merely because the same conversation has been idle for more than a
     * week. This path therefore never chooses among stored sessions and never
     * accepts a project-wide or provider-wide fallback.
     */
    reconcileLiveProviderConnection(input: {
      provider: string;
      sessionId: string;
      cwd?: string;
      processId?: number;
    }): ConnectionBinding | null {
      const provider = input.provider.trim();
      const sessionId = input.sessionId.trim();
      if (!provider || !sessionId) return null;
      if (input.processId !== undefined && !validConnectionProcessId(input.processId)) return null;
      const handle = handleForProvider(provider);
      const folder = input.cwd === undefined ? undefined : normalizeSessionFolder(projectCwd(root, input.cwd));
      const state = readState();
      const activeIdentity = state.identities.some((identity) => !identity.revokedAt
        && identity.sessionId === sessionId
        && normalizeHandle(identity.handle) === normalizeHandle(handle)
        && sameConnectionProvider(identity.provider, provider));
      if (this.identityWasRevoked(handle, sessionId)) return null;

      // A healthy provider can reconcile frequently. Avoid rewriting state on
      // every heartbeat when this exact process already owns the durable link.
      const existing = state.connectionBindings.find((binding) => sameConnectionProvider(binding.provider, provider)
        && normalizeHandle(binding.handle) === normalizeHandle(handle)
        && binding.sessionId === sessionId
        && (folder === undefined || normalizeSessionFolder(binding.cwd) === folder)
        && activeIdentity
        && (input.processId === undefined || binding.ownerProcessId === input.processId));
      if (existing) return existing;

      this.registerEndpoint({ provider, sessionId, ...(input.cwd ? { cwd: input.cwd } : {}) });
      if (!this.identityTokenFor(handle, sessionId)) this.issueIdentity(handle, provider, sessionId);
      let claim: ConnectionClaim;
      try {
        // This is a live provider observation, not a continuation guess. The
        // exact session id and current process are the ownership proof. Bind
        // the claim we just reconciled; provider-wide lookup can otherwise
        // return another active session's durable binding.
        claim = this.issueConnectionClaim({
          handle,
          provider,
          sessionId,
          ...(folder ? { cwd: folder } : {}),
          ...(input.processId !== undefined ? { ownerProcessId: input.processId } : {}),
        });
      } catch {
        return null;
      }
      if (claim.sessionId !== sessionId) return null;
      const binding = this.bindConnectionClaim(claim.claimId, {
        provider,
        ...(input.processId !== undefined ? { processId: input.processId } : {}),
      });
      if (!binding || binding.sessionId !== sessionId || !sameConnectionProvider(binding.provider, provider)) return null;
      return binding;
    },

    /** Returns the verified provider identity behind a private binding, or null if it was revoked. */
    verifyConnectionBinding(bindingId: string): VerifiedIdentity | null {
      const state = readState();
      const binding = state.connectionBindings.find((candidate) => candidate.bindingId === bindingId);
      if (!binding) return null;
      const claim = state.connectionClaims.find((candidate) => candidate.claimId === binding.claimId);
      if (!claim || claim.bindingId !== binding.bindingId) return null;
      const identity = state.identities.find((candidate) => !candidate.revokedAt && candidate.sessionId === binding.sessionId
        && normalizeHandle(candidate.handle) === normalizeHandle(binding.handle)
        && sameConnectionProvider(candidate.provider, binding.provider));
      return identity ? { handle: identity.handle, provider: identity.provider, sessionId: identity.sessionId } : null;
    },

    /** Every link this session takes part in, either side. */
    linksFor(handle: string, sessionId: string, cwd?: string): SessionLink[] {
      const projectFolder = projectCwd(root, cwd);
      const wanted = normalizeSessionRef({ handle, sessionId, cwd: projectFolder });
      const matches = (ref: SessionRef) => normalizeHandle(ref.handle) === wanted.handle
        && ref.sessionId === wanted.sessionId
        && (projectFolder === undefined || normalizeSessionFolder(projectCwd(root, ref.cwd)) === normalizeSessionFolder(projectFolder));
      return readState().links.filter((l) => matches(l.a) || matches(l.b));
    },

    /** The session this one is linked to for a given partner agent, if any. */
    linkedSession(handle: string, sessionId: string, partnerHandle: string, cwd?: string): { sessionId: string; cwd?: string } | undefined {
      let links = this.linksFor(handle, sessionId, cwd).filter((x) => normalizeHandle(x.a.handle) === normalizeHandle(partnerHandle) || normalizeHandle(x.b.handle) === normalizeHandle(partnerHandle));
      let allowLegacyFolderless = false;
      const projectFolder = projectCwd(root, cwd);
      if (links.length === 0 && projectFolder !== undefined) {
        const state = readState();
        const knownSourceFolders = state.sessions.filter((x) => normalizeHandle(x.handle) === normalizeHandle(handle) && x.sessionId === sessionId);
        const requestedFolder = normalizeSessionFolder(projectFolder);
        allowLegacyFolderless = knownSourceFolders.length === 0 || (knownSourceFolders.length === 1 && normalizeSessionFolder(knownSourceFolders[0].cwd) === requestedFolder);
        if (allowLegacyFolderless) {
          links = state.links.filter((link) => {
            const legacySource = (ref: SessionRef) => normalizeHandle(ref.handle) === normalizeHandle(handle) && ref.sessionId === sessionId && !normalizeSessionFolder(ref.cwd);
            return (legacySource(link.a) && normalizeHandle(link.b.handle) === normalizeHandle(partnerHandle)) || (legacySource(link.b) && normalizeHandle(link.a.handle) === normalizeHandle(partnerHandle));
          });
        }
      }
      if (links.length !== 1) return undefined;
      const wanted = normalizeSessionRef({ handle, sessionId, cwd: projectFolder });
      const sourceMatches = (ref: SessionRef) => normalizeHandle(ref.handle) === wanted.handle
        && ref.sessionId === wanted.sessionId
        && (projectFolder === undefined || normalizeSessionFolder(projectCwd(root, ref.cwd)) === normalizeSessionFolder(projectFolder) || (allowLegacyFolderless && !normalizeSessionFolder(ref.cwd)));
      const sourceIsA = sourceMatches(links[0].a);
      const other = sourceIsA ? links[0].b : links[0].a;
      return { sessionId: other.sessionId, ...(other.cwd ? { cwd: other.cwd } : {}) };
    },

    /** Creates or replaces the one link a session may have with a given partner agent. */
    setLink(aInput: SessionRef, bInput: SessionRef, origin: "auto" | "picked"): SessionLink {
      return update((s) => {
        const at = now().toISOString();
        const a = projectSessionRef(root, aInput);
        const b = projectSessionRef(root, bInput);
        const keep = s.links.filter((l) => !(
          (sameSessionRef(l.a, a) && l.b.handle === b.handle)
          || (sameSessionRef(l.b, a) && l.a.handle === b.handle)
          || (sameSessionRef(l.a, b) && l.b.handle === a.handle)
          || (sameSessionRef(l.b, b) && l.a.handle === a.handle)
        ));
        const link: SessionLink = { id: `L${s.nextLinkNo}`, a, b, origin, createdAt: at, updatedAt: at };
        s.nextLinkNo += 1;
        s.links = [...keep, link];
        pushEvent(s, { kind: "agent.connected", text: `linked @${a.handle} <-> @${b.handle} (${origin})` });
        return link;
      });
    },

    removeLink(id: string): void {
      update((s) => { s.links = s.links.filter((l) => l.id !== id); });
    },

    allLinks(): SessionLink[] {
      return readState().links;
    },

    addRule(input: { from: string; to: string; ttlMs: number; note?: string }): StandingRule {
      return update((s) => {
        const created = now();
        const rule: StandingRule = { id: `R${s.nextRuleNo}`, from: input.from, to: input.to, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + input.ttlMs).toISOString(), note: input.note };
        s.nextRuleNo += 1;
        s.rules.push(rule);
        pushEvent(s, { kind: "rule.created", handle: rule.to, text: `@${rule.from} may hand work to @${rule.to} until ${rule.expiresAt}` });
        return rule;
      });
    },

    revokeRule(id: string): boolean {
      return update((s) => {
        const before = s.rules.length;
        s.rules = s.rules.filter((r) => r.id !== id);
        if (s.rules.length !== before) pushEvent(s, { kind: "rule.revoked", text: `${id} revoked` });
        return s.rules.length !== before;
      });
    },

    /** Rules that have not expired yet. */
    activeRules(): StandingRule[] {
      return readState().rules.filter((r) => Date.parse(r.expiresAt) > now().getTime());
    },

    /** Lets pending approvals older than the limit lapse. Cheap when nothing is pending. */
    sweepExpired(ttlMs?: number): string[] {
      const current = readState();
      if (!current.tasks.some((t) => t.approval === "pending")) return [];
      return update((s) => {
        const ids = lapsedPending(s.tasks, now(), ttlMs);
        for (const id of ids) {
          const t = s.tasks.find((x) => x.id === id);
          if (t) { t.approval = "expired"; pushEvent(s, { kind: "task.expired", taskId: id, handle: t.to, text: `${id} lapsed without an answer` }); }
        }
        return ids;
      });
    },

    /** Tasks waiting for the user's yes (not lapsed). */
    pendingApprovals(): Task[] {
      const lapsed = new Set(lapsedPending(readState().tasks, now()));
      return readState().tasks.filter((t) => t.approval === "pending" && !lapsed.has(t.id));
    },

    /** Endpoints, tasks, events and cursors in one read (used when syncing to the web app). */
    snapshot(): { endpoints: EndpointRecord[]; sessions: SessionRecord[]; tasks: Task[]; events: EventRecord[]; cursors: Record<string, number> } {
      const s = readState();
      return { endpoints: Object.values(s.endpoints), sessions: s.sessions, tasks: s.tasks, events: s.events, cursors: s.cursors };
    },

    getTask(id: string): Task | undefined {
      return readState().tasks.find((t) => t.id === id);
    },

    tasksFrom(handle: string): Task[] {
      const normalizedHandle = normalizeHandle(handle);
      return readState().tasks.filter((t) => normalizeHandle(t.from) === normalizedHandle);
    },

    tasksFor(handle: string): Task[] {
      const normalizedHandle = normalizeHandle(handle);
      return readState().tasks.filter((t) => normalizeHandle(t.to) === normalizedHandle);
    },

    /** Inbox view for one provider session. Once claimed, an untargeted task belongs to that session alone. */
    tasksForSession(handle: string, sessionId: string): Task[] {
      const normalizedHandle = normalizeHandle(handle);
      return readState().tasks.filter((task) => normalizeHandle(task.to) === normalizedHandle && (!(task.targetSession ?? task.deliveredSession) || (task.targetSession ?? task.deliveredSession) === sessionId));
    },

    /**
     * The taskId a stage-tool call should default to when it omits one, among a set of
     * candidate pending taskIds -- whichever one this session most recently dispatched a real
     * stage operation against, if any, AND only if that activity happened within the active-turn
     * window. Exists so an in-progress multi-call turn (observe, then several actions, each free
     * to omit taskId) keeps landing on the exact task it started acting on, even if a newer task
     * arrives mid-turn; falling back to "newest created" alone would silently retarget an ongoing
     * operation onto an unrelated queued request.
     *
     * The staleness bound is the fix for a real bug this exact mechanism caused, live, 2026-10-17:
     * with no bound, a brand-new task's very first call (zero operations yet) always lost to ANY
     * older pending task that had ever had one operation recorded against it, however long ago --
     * a two-day-old orphaned "launch File Explorer" task (T236) hijacked a fresh "open Chrome"
     * task's app launch this way. A real turn's calls happen seconds to low minutes apart, never
     * days; activity older than that is itself an abandoned turn, not the current one.
     */
    mostRecentlyActiveTaskId(handle: string, sessionId: string, candidateIds: readonly string[]): string | undefined {
      const normalizedHandle = normalizeHandle(handle);
      const candidates = new Set(candidateIds);
      const cutoff = now().getTime() - ACTIVE_TURN_WINDOW_MS;
      let best: { taskId: string; updatedAt: number } | undefined;
      for (const record of readState().stageOperations) {
        if (normalizeHandle(record.handle) !== normalizedHandle || record.sessionId !== sessionId || !candidates.has(record.taskId)) continue;
        const updatedAt = Date.parse(record.updatedAt);
        if (updatedAt < cutoff) continue;
        if (!best || updatedAt > best.updatedAt) best = { taskId: record.taskId, updatedAt };
      }
      return best?.taskId;
    },

    /**
     * What this session's actual open work is -- distinct from the inbox, which deliberately
     * hides anything already pushed as a prompt (a real, one-shot replay fence, kept as-is).
     * That fence means a task that was genuinely delivered earlier (a live push, a prior inbox
     * read, a reconnect) never shows up in the inbox again, even though it is still open and the
     * agent may have no memory of it (a fresh session, a restarted provider process). Confirmed
     * live, 2026-10-17: an agent reported "inbox is empty" for a task that had, in fact, already
     * been delivered and was still awaiting a result -- the inbox was telling the truth about
     * unread messages and nothing about pending work, and nothing distinguished the two for the
     * agent. This is the generic "what do I actually still owe a result for" lookup Codex's
     * audit asked for, independent of the inbox's replay semantics.
     */
    /**
     * One durable color per agent handle (Findings I/AD): known provider identities use the
     * owner-approved fixed palette, while unknown handles receive one stable overflow color.
     * Existing known-provider assignments are migrated once to the approved fixed color; this
     * prevents an older local state file from silently preserving the previous rotating palette.
     */
    colorFor(handle: string): string {
      const normalized = normalizeHandle(handle);
      const fixed = CURSOR_BRAND_COLORS[normalized];
      // Rendering an existing assignment must not acquire a write lock or rewrite state.
      const assigned = readState().cursorColors[normalized];
      if (assigned && (!fixed || assigned === fixed)) return assigned;
      return update((s) => {
        const existing = s.cursorColors[normalized];
        if (fixed) {
          if (existing === fixed) return fixed;
          // A legacy/unknown handle may have received this now-reserved color before the
          // provider palette was finalized. Move only that non-provider handle to an overflow
          // color before installing the fixed identity color.
          const conflicting = Object.entries(s.cursorColors).find(([other, color]) => other !== normalized && color === fixed);
          if (conflicting) {
            const used = new Set(Object.values(s.cursorColors));
            used.delete(fixed);
            const replacement = CURSOR_COLOR_PALETTE.find((color) => !used.has(color))
              ?? CURSOR_COLOR_PALETTE[used.size % CURSOR_COLOR_PALETTE.length]!;
            s.cursorColors[conflicting[0]] = replacement;
          }
          s.cursorColors[normalized] = fixed;
          return fixed;
        }
        if (existing) return existing;
        const used = new Set(Object.values(s.cursorColors));
        const chosen = CURSOR_COLOR_PALETTE.find((color) => !used.has(color) && !RESERVED_CURSOR_COLORS.has(color))
          ?? CURSOR_COLOR_PALETTE[used.size % CURSOR_COLOR_PALETTE.length]!;
        s.cursorColors[normalized] = chosen;
        return chosen;
      });
    },

    pendingWorkFor(handle: string, sessionId: string): Task[] {
      const normalizedHandle = normalizeHandle(handle);
      const maxAge = inboxMaxAgeMs();
      const cutoff = now().getTime() - maxAge;
      return readState().tasks.filter((task) => normalizeHandle(task.to) === normalizedHandle
        && (!(task.targetSession ?? task.deliveredSession) || (task.targetSession ?? task.deliveredSession) === sessionId)
        && !task.resultSummary
        // Terminal delivery/lifecycle failures are history, not a reason to
        // block provider identity repair or make an incidental prompt look
        // like it is carrying live delegated work.
        && task.delivery?.state !== "failed"
        && task.lifecycle?.state !== "failed"
        && task.lifecycle?.state !== "completed"
        && (task.approval === "approved" || task.approval === "not_needed")
        && Date.parse(task.createdAt) >= cutoff);
    },

    /**
     * Finds the one active owner-approved turn that authorizes an ordinary delegation.
     *
     * This is deliberately fail-closed: a provider session may inherit approval only when
     * it is actively carrying exactly one fresh, delivered, unfinished task. Protected work
     * never inherits approval, and ambiguous/stale state remains pending for an owner decision.
     */
    delegationParentFor(handle: string, sessionId: string, goal: string): Task | undefined {
      if (!sessionId || isProtectedAction(goal)) return undefined;
      const normalizedHandle = normalizeHandle(handle);
      const cutoff = now().getTime() - inboxMaxAgeMs();
      const candidates = readState().tasks.filter((task) => {
        if (normalizeHandle(task.to) !== normalizedHandle || task.resultSummary) return false;
        if (task.approval !== "approved" && task.approval !== "not_needed") return false;
        if (task.lifecycle?.state === "failed" || task.lifecycle?.state === "completed") return false;
        const owner = task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId;
        if (owner !== sessionId || !task.deliveredAt) return false;
        const createdAt = Date.parse(task.createdAt);
        const deliveredAt = Date.parse(task.deliveredAt);
        const current = now().getTime();
        return Number.isFinite(createdAt) && Number.isFinite(deliveredAt)
          && createdAt >= cutoff && deliveredAt <= current;
      });
      if (candidates.length !== 1) return undefined;
      return candidates[0];
    },

    /**
     * Atomically assigns an inbox batch to the provider session that is actually reading it.
     * The store lock covers ownership checks, delivery receipt, and cursor movement so concurrent
     * hooks or MCP inbox calls cannot hand the same task to two sessions.
     */
    claimInboxTasks(handle: string, sessionId: string, ids: readonly string[], cwd?: string): Task[] {
      if (!sessionId || ids.length === 0) return [];
      const wanted = new Set(ids.slice(0, 50));
      if (wanted.size === 0) return [];
      const normalizedHandle = normalizeHandle(handle);
      const folder = projectCwd(root, cwd);
      return update((s) => {
        const key = cursorKey(normalizedHandle, sessionId, folder);
        let cursor = s.cursors[key] ?? 0;
        const at = now();
        const maxAge = inboxMaxAgeMs();
        const claimed: Task[] = [];
        const candidates = s.tasks
          .filter((task) => wanted.has(task.id) && normalizeHandle(task.to) === normalizedHandle)
          .sort((a, b) => a.seq - b.seq);
        for (const task of candidates) {
          if (task.seq <= cursor) continue;
          // A push may already be executing. Inbox fallback must not race or replay it.
          if (task.delivery?.state === "sending" || task.delivery?.state === "uncertain") continue;
          const failedPush = task.delivery?.state === "failed";
          if (task.approval === "denied" || task.approval === "expired"
            || task.receipt?.state === "canceled"
            || task.delivery?.state === "queued" || task.delivery?.state === "done" || task.resultSummary
            || at.getTime() - Date.parse(task.createdAt) > maxAge) {
            cursor = Math.max(cursor, task.seq);
            continue;
          }
          // Approval is a delivery gate, not merely an instruction to the
          // provider. Never mark pending work presented or move the cursor
          // past it; the next approved inbox read must be able to claim it.
          if (task.approval === "pending") continue;
          // Explicit routing wins over a stale incidental delivery record. Without an
          // explicit target, the first real inbox read owns the task from then on.
          const owner = task.targetSession ?? task.deliveredSession;
          if (owner && owner !== sessionId) {
            cursor = Math.max(cursor, task.seq);
            continue;
          }
          // The same provider session may have separate cursor scopes for different
          // projects. A delivery receipt is still a global one-shot fence for the task.
          // Legacy explicitly-targeted rows with a conflicting deliveredSession are
          // allowed through once so the intended session can repair the old receipt.
          if (!failedPush && task.deliveredAt && owner === sessionId && !(task.targetSession === sessionId && task.deliverySource === undefined)) {
            cursor = Math.max(cursor, task.seq);
            continue;
          }
          const firstDelivery = !task.deliveredAt || failedPush;
          if (failedPush) task.deliveredAt = at.toISOString();
          else task.deliveredAt ??= at.toISOString();
          task.deliveredSession = task.targetSession ?? sessionId;
          task.deliverySource = "prompt";
          applyTaskLifecycle(task, {
            state: "presented",
            sessionId: task.targetSession ?? sessionId,
            source: "prompt",
            presentedAt: task.deliveredAt,
          });
          recordTaskReceipt(task, {
            state: "provider_received",
            at: task.deliveredAt,
            source: "prompt",
            sessionId: task.targetSession ?? sessionId,
          });
          cursor = Math.max(cursor, task.seq);
          claimed.push(task);
          if (firstDelivery) pushEvent(s, { kind: "task.delivered", taskId: task.id, handle: task.to, text: `${task.id} was read by @${task.to}'s session` });
        }
        if (cursor > (s.cursors[key] ?? 0)) s.cursors[key] = cursor;
        return claimed;
      });
    },

    setApproval(id: string, approval: Approval): Task | undefined {
      return update((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (t) {
          const wasPending = t.approval === "pending";
          t.approval = approval;
          // Agent-originated native Claude work becomes eligible for the resident
          // delivery pump only after the owner's explicit approval. Previously
          // this transition changed only the approval field, so the pump (which
          // scans deferred work) never saw it; delivery waited for a later prompt
          // hook or manual inbox read. Keep room tasks, other transports, stale
          // work, and any task with prior delivery history out of this path.
          if (approval === "approved" && wasPending
            && t.origin === "agent_initiated"
            && normalizeHandle(t.to) === "claude"
            && !t.delivery && !t.resultSummary && !t.deliveredAt && !t.deliveredSession
            && t.receipt?.state !== "canceled"
            && isFreshInboxTask(t.createdAt, now().getTime(), inboxMaxAgeMs())) {
            t.delivery = { state: "deferred", attempts: 0 };
          }
          if (approval === "approved" || approval === "denied") pushEvent(s, { kind: approval === "approved" ? "task.approved" : "task.denied", taskId: id, handle: t.to, text: `${id} ${approval}` });
        }
        return t;
      });
    },

    /** Claim before any asynchronous provider work. An uncertain send must be reconciled, never replayed. */
    claimCodexDelivery(id: string): Task | undefined {
      return update((s) => {
        const task = s.tasks.find((item) => item.id === id);
        if (!task || task.to !== "codex" || task.resultSummary || task.deliveredAt || task.receipt?.state === "canceled" || !canQueue(task)
          || !isFreshInboxTask(task.createdAt, now().getTime(), inboxMaxAgeMs())) return undefined;
        if (task.delivery && task.delivery.state !== "failed" && task.delivery.state !== "deferred") return undefined;
        const claimedAt = now().toISOString();
        task.delivery = { state: "sending", attempts: (task.delivery?.attempts ?? 0) + 1, claimedAt };
        applyTaskLifecycle(task, { state: "queued", source: "push", queuedAt: claimedAt });
        recordTaskReceipt(task, {
          state: "dispatched",
          at: claimedAt,
          attempt: task.delivery.attempts,
          source: "provider-transport",
          ...(task.delivery.threadId ? { sessionId: task.delivery.threadId } : {}),
        });
        return task;
      });
    },

    /** Records how far native delivery got (queued, failed, done); attempts are counted for the ledger. */
    setDelivery(id: string, patch: Partial<TaskDelivery> & Pick<TaskDelivery, "state">): Task | undefined {
      return update((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return undefined;
        if (t.delivery?.state === "done" || t.resultSummary || t.receipt?.state === "canceled") return t;
        const at = now().toISOString();
        const receiptState = receiptStateForDelivery(t, patch.state);
        rememberDelivery(t);
        t.delivery = { attempts: 0, ...t.delivery, ...patch,
          ...(patch.error ? { error: redactSecrets(patch.error).slice(0, 500) } : {}) };
        if (patch.state === "sending") {
          applyTaskLifecycle(t, { state: "queued", sessionId: patch.threadId ?? t.deliveredSession, source: "push", queuedAt: t.delivery.claimedAt ?? at });
        } else if (patch.state === "queued") {
          applyTaskLifecycle(t, { state: "acknowledged", sessionId: patch.threadId ?? t.deliveredSession, source: "push", acknowledgedAt: t.delivery.queuedAt ?? at });
        } else if (patch.state === "failed") {
          applyTaskLifecycle(t, { state: "failed", sessionId: t.deliveredSession, source: t.deliverySource, error: patch.error, completedAt: at });
        }
        recordTaskReceipt(t, {
          state: receiptState,
          at,
          attempt: t.delivery.attempts,
          source: patch.state === "failed" || patch.state === "uncertain" ? "provider-transport" : "provider-transport",
          ...(patch.threadId ?? t.deliveredSession ? { sessionId: patch.threadId ?? t.deliveredSession } : {}),
          ...(patch.error ? { error: patch.error } : {}),
        });
        if (patch.state === "uncertain") pushEvent(s, { kind: "task.delivery_uncertain", taskId: id, handle: t.to,
          text: `${id} delivery to @${t.to} could not be confirmed; it will not be resent automatically` });
        if (patch.state === "queued" && patch.threadId && !t.deliveredSession) t.deliveredSession = patch.threadId;
        if (patch.state === "queued" && !t.deliveredAt) {
          t.deliveredAt = at;
          t.deliverySource = "push";
          pushEvent(s, { kind: "task.delivered", taskId: id, handle: t.to, text: `${id} pushed into @${t.to}'s session` });
        }
        return t;
      });
    },

    /** Atomically claims one OpenCode task so independent pollers cannot inject the same turn twice. */
    claimOpenCodeTask(id: string, input: { sessionId: string; identityToken: string; cwd?: string; activeWindowMs: number; maxAgeMs: number }): Task | undefined {
      return update((s) => {
        const at = now();
        const handle = "opencode";
        const folder = normalizeSessionFolder(projectCwd(root, input.cwd));
        const identity = s.identities.find((item) => !item.revokedAt && item.token === input.identityToken
          && normalizeHandle(item.handle) === handle && item.sessionId === input.sessionId);
        if (!identity) return undefined;
        const activeSessions = s.sessions.filter((session) => normalizeHandle(session.handle) === handle
          && session.sessionId === input.sessionId
          && normalizeSessionFolder(session.cwd) === folder
          && at.getTime() - Date.parse(session.lastSeenAt) >= 0
          && at.getTime() - Date.parse(session.lastSeenAt) < input.activeWindowMs);
        if (activeSessions.length !== 1) return undefined;
        const task = s.tasks.find((candidate) => candidate.id === id);
        // `delivery` is the durable at-most-once fence. `deliveredAt` also
        // fences records created by older releases that advanced the inbox
        // cursor before delivery metadata existed. Neither may be replayed.
        if (!task || normalizeHandle(task.to) !== handle
          || (task.delivery && task.delivery.state !== "deferred")
          || task.receipt?.state === "canceled"
          || task.deliveredAt || task.resultSummary || !canQueue(task)) return undefined;
        const cursor = s.cursors[cursorKey(handle, input.sessionId, folder)] ?? 0;
        if (task.seq <= cursor || !(task.targetSession === input.sessionId
          || (!task.targetSession && activeSessions.length === 1))
          || (task.cwd && (!folder || normalizeSessionFolder(task.cwd) !== folder))) return undefined;
        const createdAt = Date.parse(task.createdAt);
        if (!Number.isFinite(createdAt) || at.getTime() - createdAt < 0 || at.getTime() - createdAt > input.maxAgeMs) return undefined;
        rememberDelivery(task);
        task.delivery = { attempts: 1, state: "sending", threadId: input.sessionId, claimedAt: at.toISOString(), transport: "opencode-session-api" };
        task.deliveredSession = input.sessionId;
        recordTaskReceipt(task, {
          state: "dispatched",
          at: at.toISOString(),
          attempt: task.delivery.attempts,
          source: "provider-transport",
          sessionId: input.sessionId,
        });
        applyTaskLifecycle(task, { state: "presented", sessionId: input.sessionId, source: "poll", presentedAt: at.toISOString() });
        s.cursors[cursorKey(handle, input.sessionId, folder)] = Math.max(cursor, task.seq);
        return task;
      });
    },

    /** Finalizes an already-claimed task. A failed or accepted task is never made pollable again. */
    settleOpenCodeTask(id: string, sessionId: string, identityToken: string, outcome: { state: "queued" } | { state: "failed" | "uncertain"; error: string }): boolean {
      return update((s) => {
        const handle = "opencode";
        const identity = s.identities.find((item) => !item.revokedAt && item.token === identityToken
          && normalizeHandle(item.handle) === handle && item.sessionId === sessionId);
        if (!identity) return false;
        const task = s.tasks.find((candidate) => candidate.id === id);
        if (!task || normalizeHandle(task.to) !== handle) return false;
        if (task.receipt?.state === "canceled") return false;
        const delivery = task.delivery;
        if (delivery?.threadId !== sessionId) return false;
        if (outcome.state === "queued" && (delivery.state === "queued" || delivery.state === "done")) return true;
        if (outcome.state === "failed" && delivery.state === "failed") return true;
        if (outcome.state === "uncertain" && delivery.state === "uncertain") return true;
        // A provider can accept promptAsync (queued) and fail later inside its
        // model/session loop. That is a terminal provider failure, not an
        // uncertain transport result, and must be closable without replaying
        // the already-created provider turn.
        const canRecordExecutionFailure = outcome.state === "failed" && (delivery.state === "sending" || delivery.state === "queued");
        if (delivery.state !== "sending" && !(outcome.state === "queued" && delivery.state === "uncertain") && !canRecordExecutionFailure) return false;
        const at = now().toISOString();
        if (outcome.state === "queued") {
          rememberDelivery(task);
          task.delivery = { ...delivery, state: "queued", queuedAt: at };
          task.deliveredAt = at;
          recordTaskReceipt(task, { state: "provider_received", at, attempt: task.delivery.attempts, source: "provider-transport", sessionId });
          applyTaskLifecycle(task, { state: "acknowledged", sessionId, source: "poll", acknowledgedAt: at });
          pushEvent(s, { kind: "task.delivered", taskId: id, handle, text: `${id} accepted by @opencode's session` });
        } else if (outcome.state === "failed") {
          rememberDelivery(task);
          task.delivery = { ...delivery, state: "failed", failedAt: at, error: redactSecrets(outcome.error).slice(0, 240) };
          recordTaskReceipt(task, { state: "failed", at, attempt: task.delivery.attempts, source: "provider-transport", sessionId, error: outcome.error });
          applyTaskLifecycle(task, { state: "failed", sessionId, source: "poll", error: outcome.error, completedAt: at });
          pushEvent(s, { kind: "task.delivery_failed", taskId: id, handle, text: `${id} was rejected by @opencode's session` });
        } else {
          rememberDelivery(task);
          task.delivery = { ...delivery, state: "uncertain", uncertainAt: at, error: redactSecrets(outcome.error).slice(0, 240) };
          recordTaskReceipt(task, { state: "uncertain", at, attempt: task.delivery.attempts, source: "provider-transport", sessionId, error: outcome.error });
          pushEvent(s, { kind: "task.delivery_uncertain", taskId: id, handle, text: `${id} delivery to @opencode could not be confirmed; it will not be resent automatically` });
        }
        return true;
      });
    },

    /**
     * Tasks pushed into a provider session that have not produced a result yet.
     * This is intentionally a read-only eligibility filter: stale records are
     * retained for evidence, but no result collector may keep reopening them.
     */
    awaitingResults(provider?: string): Task[] {
      const at = now().getTime();
      const requestedProvider = provider ? normalizeHandle(provider) : undefined;
      return readState().tasks.filter((t) => {
        if (t.resultSummary || (requestedProvider && normalizeHandle(t.to) !== requestedProvider)) return false;
        const createdAt = Date.parse(t.createdAt);
        if (!Number.isFinite(createdAt) || createdAt > at || at - createdAt > RESULT_RECONCILIATION_MAX_AGE_MS) return false;
        return t.delivery?.state === "queued"
          || (normalizeHandle(t.to) === "codex" && Boolean(t.delivery?.threadId)
            && (t.delivery?.state === "sending" || t.delivery?.state === "uncertain"));
      });
    },

    /** Clears items from the overlay's "needs you" list. Never touches approval, delivery or results. */
    dismiss(ids: readonly string[]): number {
      return update((s) => {
        let n = 0;
        for (const id of ids) { const t = s.tasks.find((x) => x.id === id); if (t && !t.dismissedAt) { t.dismissedAt = now().toISOString(); n += 1; } }
        return n;
      });
    },

    markResultShown(ids: readonly string[]): void {
      if (ids.length === 0) return;
      update((s) => {
        for (const id of ids) {
          const t = s.tasks.find((x) => x.id === id);
          if (t && !t.resultShownAt) t.resultShownAt = now().toISOString();
        }
      });
    },

    /**
     * Closes a task without pretending that its provider transport failed.
     * The canonical receipt is the cancellation fence used by every delivery
     * claimant and by the provider-neutral delivery pump.
     */
    cancelTask(id: string, reason = "Task canceled by the owner."): Task | undefined {
      return update((s) => {
        const task = s.tasks.find((candidate) => candidate.id === id);
        if (!task || task.resultSummary || task.receipt?.state === "completed" || task.receipt?.state === "canceled") return task;
        const at = now().toISOString();
        recordTaskReceipt(task, { state: "canceled", at, source: "owner-broker", error: reason });
        pushEvent(s, { kind: "task.canceled", taskId: id, handle: task.to, text: `${id} was canceled: ${redactSecrets(reason).slice(0, 160)}` });
        return task;
      });
    },

    setResult(id: string, summary: string): Task | undefined {
      return update((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return undefined;
        if (t.receipt?.state === "canceled") return t;
        const clean = redactSecrets(summary.trim());
        const at = now().toISOString();
        rememberDelivery(t);
        if (t.delivery) t.delivery = { ...t.delivery, state: "done" };
        recordTaskReceipt(t, { state: "completed", at, source: "provider-session", ...(t.deliveredSession ? { sessionId: t.deliveredSession } : {}) });
        applyTaskLifecycle(t, { state: "completed", sessionId: t.deliveredSession, source: t.deliverySource, completedAt: at });
        t.resultSummary = clean.length > MAX_RESULT_SUMMARY_CHARS ? clean.slice(0, MAX_RESULT_SUMMARY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER : clean;
        pushEvent(s, { kind: "task.result", taskId: id, handle: t.from, text: `${id} finished: ${t.resultSummary.slice(0, 120)}` });
        return t;
      });
    },

    /** Record an authenticated result once, in the same transaction that checks its session ownership. */
    recordTaskResult(token: string, id: string, summary: string): { ok: boolean; error?: string; alreadyRecorded?: boolean } {
      const clean = redactSecrets(summary.trim());
      if (!clean) return { ok: false, error: "A task result needs a summary." };
      const bounded = clean.length > MAX_RESULT_SUMMARY_CHARS
        ? clean.slice(0, MAX_RESULT_SUMMARY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
        : clean;
      return update((s) => {
        const identity = verifyToken(s.identities, token);
        if (!identity) return { ok: false, error: "This M9R session identity is not active in the owner broker." };
        const task = s.tasks.find((item) => item.id === id);
        if (!task) return { ok: false, error: `No task ${id} found.` };
        const handle = normalizeHandle(identity.handle);
        const roomHandle = identity.sessionId.startsWith("web-") ? `web-${handle}` : handle;
        if (normalizeHandle(task.to) !== handle && normalizeHandle(task.to) !== roomHandle) {
          return { ok: false, error: `Task ${id} was not sent to you (@${handle}), refusing to report a result for it.` };
        }
        const owner = task.targetSession ?? task.deliveredSession;
        if (owner && owner !== identity.sessionId) return { ok: false, error: `Task ${id} belongs to another session of this agent.` };
        if (!identity.sessionId.startsWith("web-") && (!task.deliveredAt || !owner)) {
          return { ok: false, error: `Task ${id} has not been delivered to this session.` };
        }
        if (task.resultSummary) {
          if (task.resultSummary === bounded) return { ok: true, alreadyRecorded: true };
          return { ok: false, error: `Task ${id} already has a recorded result; it was not overwritten.` };
        }
        if (task.receipt?.state === "canceled") return { ok: false, error: `Task ${id} was canceled; its late result was refused.` };
        const inFlightStage = s.stageOperations.find((operation) => operation.taskId === id && operation.state === "running");
        if (inFlightStage) {
          return { ok: false, error: `Task ${id} still has an in-flight desktop-stage operation; wait for operation ${inFlightStage.key} to settle before recording the result.` };
        }
        if (task.targetSession && task.targetSession === identity.sessionId) task.deliveredSession = identity.sessionId;
        const at = now().toISOString();
        rememberDelivery(task);
        if (task.delivery) task.delivery = { ...task.delivery, state: "done" };
        recordTaskReceipt(task, { state: "completed", at, source: "provider-session", sessionId: identity.sessionId });
        applyTaskLifecycle(task, { state: "completed", sessionId: identity.sessionId, source: task.deliverySource, completedAt: at });
        task.resultSummary = bounded;
        pushEvent(s, { kind: "task.result", taskId: id, handle: task.from, text: `${id} finished: ${task.resultSummary.slice(0, 120)}` });
        return { ok: true };
      });
    },

    /**
     * Inbox cursors are scoped to provider session and project, while task ownership is global to the provider
     * session that first claims delivery. This keeps parallel sessions from duplicating work and lets each
     * session advance independently past tasks addressed to someone else. Callers without a session id retain
     * the handle-only cursor for compatibility, but cannot claim or execute native inbox tasks.
     */
    cursorFor(handle: string, sessionId?: string, cwd?: string): number {
      return readState().cursors[cursorKey(handle, sessionId, projectCwd(root, cwd))] ?? 0;
    },

    setCursor(handle: string, sessionId: string | undefined, seq: number, cwd?: string): void {
      update((s) => {
        const key = cursorKey(handle, sessionId, projectCwd(root, cwd));
        if (seq > (s.cursors[key] ?? 0)) s.cursors[key] = seq;
      });
    },
  };
}

export type LocalStore = ReturnType<typeof createLocalStore>;

/** `M9R_HOME` overrides the default so tests and separate profiles never touch the real one. */
export function defaultStoreRoot(home: string, env: Record<string, string | undefined> = process.env): string {
  return env.M9R_HOME?.trim() || join(home, ".m9r");
}
