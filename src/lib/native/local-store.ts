/**
 * The M9R Node's local state for the native front door: endpoints seen on this machine, tasks and inbox cursors.
 * One small JSON file under the user's M9R home, written atomically and guarded by a lock directory so a hook and the
 * CLI can never corrupt each other. Everything is synchronous: a hook is a short-lived process.
 *
 * Local first: nothing here needs the network or an account (design section 1, principle 7).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { lapsedPending, ruleCovers, type StandingRule } from "./approval-core";
import { MAX_RESULT_SUMMARY_CHARS, TRUNCATION_MARKER, findByIdempotencyKey, inboxMaxAgeMs, newTask, normalizeHandle, pruneTasks, redactSecrets, type Approval, type NewTaskInput, type Task, type TaskDelivery } from "./inbox-core";
import { canQueue } from "./codex-delivery-core";
import { issueIdentity, verifyToken, type IdentityToken, type VerifiedIdentity } from "./identity-core";

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
  kind: "agent.connected" | "session.started" | "task.created" | "task.delivered" | "task.delivery_failed" | "task.delivery_uncertain" | "task.approved" | "task.denied" | "task.expired" | "task.result" | "rule.created" | "rule.revoked" | "mention.double";
  handle?: string;
  taskId?: string;
  text: string;
}

const MAX_EVENTS = 500;
/** Keep receipts for recent stage actions so an MCP retry cannot repeat an OS input. */
const MAX_STAGE_OPERATION_RECEIPTS = 10_000;
/** Hard ceiling for the complete local snapshot, including extensible cursor and rule maps. */
export const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024;
/** Keep each rewritten local state file within a predictable task count when user work can be retired safely. */
export const MAX_STORED_TASKS = 2_000;
const RESOLVED_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;

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
}

export interface SessionLink {
  id: string;
  a: { handle: string; sessionId: string; cwd?: string };
  b: { handle: string; sessionId: string; cwd?: string };
  origin: "auto" | "picked";
  createdAt: string;
  updatedAt: string;
}

const emptyState = (): StoreState => ({ version: 1, nextTaskNo: 1, nextSeq: {}, tasks: [], cursors: {}, endpoints: {}, events: [], rules: [], nextRuleNo: 1, sessions: [], links: [], nextLinkNo: 1, identities: [], stageOperations: [] });

const stageOperationKey = (input: StageOperationInput): string => createHash("sha256")
  .update(JSON.stringify([normalizeHandle(input.handle), input.sessionId, input.taskId, input.operationId]))
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

const normalizeStoredScopes = (storeRoot: string, state: StoreState): StoreState => {
  state.endpoints = Object.fromEntries(Object.entries(state.endpoints).map(([key, value]) => [key, dropInstallCwd(storeRoot, value)]));
  state.sessions = state.sessions.map((session) => dropInstallCwd(storeRoot, session));
  state.tasks = state.tasks.map((task) => dropInstallCwd(storeRoot, task));
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
const LOCK_STALE_MS = 15_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface LocalStoreDeps {
  now?: () => Date;
  /** Tests and embedded callers may choose a lower limit; the production maximum cannot be raised. */
  maxStateBytes?: number;
}

export function createLocalStore(root: string, deps: LocalStoreDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const statePath = join(root, "state.json");
  const lockPath = join(root, "state.lock");
  const maxStateBytes = Math.min(MAX_LOCAL_STATE_BYTES, Math.max(1, Math.floor(deps.maxStateBytes ?? MAX_LOCAL_STATE_BYTES)));

  function acquire(): void {
    mkdirSync(root, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { rmSync(lockPath, { recursive: true, force: true }); continue; }
        } catch { /* lock vanished: retry */ }
        if (Date.now() > deadline) throw new Error("The M9R local store is busy; try again.");
        sleepSync(15);
      }
    }
  }

  function readState(): StoreState {
    if (!existsSync(statePath)) return emptyState();
    const fileBytes = statSync(statePath).size;
    if (fileBytes > maxStateBytes) throw new LocalStateCapacityError(fileBytes, maxStateBytes);
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StoreState;
      return parsed && parsed.version === 1 ? normalizeStoredScopes(root, {
        ...emptyState(),
        ...parsed,
        stageOperations: Array.isArray(parsed.stageOperations) ? parsed.stageOperations : [],
      }) : emptyState();
    } catch {
      // A corrupt file must never brick the agent's prompts: keep it aside and start clean.
      try { renameSync(statePath, `${statePath}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return emptyState();
    }
  }



  const pushEvent = (s: StoreState, event: Omit<EventRecord, "at">) => {
    s.events.push({ at: now().toISOString(), ...event });
    if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS);
  };

  /** On Windows a rename over a file another process is reading can fail with EPERM/EBUSY for a moment; retry, then copy. */
  function renameWithRetry(from: string, to: string): void {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { renameSync(from, to); return; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
    copyFileSync(from, to);
    try { rmSync(from, { force: true }); } catch { /* the temp file is harmless */ }
  }

  /** Runs `fn` on the state under the lock and writes the result atomically. */
  function update<T>(fn: (state: StoreState) => T): T {
    acquire();
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
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  return {
    root,

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
        if (existing) return { task: existing, created: false };
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

    /** Ends a session's token early (the person revoked it from the pill, or the session closed). */
    revokeIdentity(sessionId: string): void {
      update((s) => { const at = now().toISOString(); for (const t of s.identities) if (t.sessionId === sessionId && !t.revokedAt) t.revokedAt = at; });
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
          if (task.approval === "denied" || task.approval === "expired"
            || task.delivery?.state === "queued" || task.delivery?.state === "done" || task.resultSummary
            || at.getTime() - Date.parse(task.createdAt) > maxAge) {
            cursor = Math.max(cursor, task.seq);
            continue;
          }
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
          if (task.deliveredAt && owner === sessionId && !(task.targetSession === sessionId && task.deliverySource === undefined)) {
            cursor = Math.max(cursor, task.seq);
            continue;
          }
          const firstDelivery = !task.deliveredAt;
          task.deliveredAt ??= at.toISOString();
          task.deliveredSession = task.targetSession ?? sessionId;
          task.deliverySource = "prompt";
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
          t.approval = approval;
          if (approval === "approved" || approval === "denied") pushEvent(s, { kind: approval === "approved" ? "task.approved" : "task.denied", taskId: id, handle: t.to, text: `${id} ${approval}` });
        }
        return t;
      });
    },

    /** Records how far native delivery got (queued, failed, done); attempts are counted for the ledger. */
    setDelivery(id: string, patch: Partial<TaskDelivery> & Pick<TaskDelivery, "state">): Task | undefined {
      return update((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return undefined;
        t.delivery = { attempts: 0, ...t.delivery, ...patch };
        if (patch.state === "queued" && patch.threadId && !t.deliveredSession) t.deliveredSession = patch.threadId;
        if (patch.state === "queued" && !t.deliveredAt) {
          t.deliveredAt = now().toISOString();
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
        if (!task || normalizeHandle(task.to) !== handle || task.delivery || task.deliveredAt || task.resultSummary || !canQueue(task)) return undefined;
        const cursor = s.cursors[cursorKey(handle, input.sessionId, folder)] ?? 0;
        if (task.seq <= cursor || !(task.targetSession === input.sessionId
          || (!task.targetSession && activeSessions.length === 1))
          || (task.cwd && (!folder || normalizeSessionFolder(task.cwd) !== folder))) return undefined;
        const createdAt = Date.parse(task.createdAt);
        if (!Number.isFinite(createdAt) || at.getTime() - createdAt < 0 || at.getTime() - createdAt > input.maxAgeMs) return undefined;
        task.delivery = { attempts: 1, state: "sending", threadId: input.sessionId, claimedAt: at.toISOString() };
        task.deliveredSession = input.sessionId;
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
        const delivery = task.delivery;
        if (delivery?.threadId !== sessionId) return false;
        if (outcome.state === "queued" && (delivery.state === "queued" || delivery.state === "done")) return true;
        if (outcome.state === "failed" && delivery.state === "failed") return true;
        if (outcome.state === "uncertain" && delivery.state === "uncertain") return true;
        if (delivery.state !== "sending") return false;
        const at = now().toISOString();
        if (outcome.state === "queued") {
          task.delivery = { ...delivery, state: "queued", queuedAt: at };
          task.deliveredAt = at;
          pushEvent(s, { kind: "task.delivered", taskId: id, handle, text: `${id} accepted by @opencode's session` });
        } else if (outcome.state === "failed") {
          task.delivery = { ...delivery, state: "failed", failedAt: at, error: redactSecrets(outcome.error).slice(0, 240) };
          pushEvent(s, { kind: "task.delivery_failed", taskId: id, handle, text: `${id} was rejected by @opencode's session` });
        } else {
          task.delivery = { ...delivery, state: "uncertain", uncertainAt: at, error: redactSecrets(outcome.error).slice(0, 240) };
          pushEvent(s, { kind: "task.delivery_uncertain", taskId: id, handle, text: `${id} delivery to @opencode could not be confirmed; it will not be resent automatically` });
        }
        return true;
      });
    },

    /** Tasks pushed into a session that have not produced a result yet. */
    awaitingResults(): Task[] {
      return readState().tasks.filter((t) => t.delivery?.state === "queued" && !t.resultSummary);
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

    setResult(id: string, summary: string): Task | undefined {
      return update((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return undefined;
        const clean = redactSecrets(summary.trim());
        if (t.delivery?.state === "queued") t.delivery = { ...t.delivery, state: "done" };
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
        if (task.targetSession && task.targetSession === identity.sessionId) task.deliveredSession = identity.sessionId;
        if (task.delivery?.state === "queued") task.delivery = { ...task.delivery, state: "done" };
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
