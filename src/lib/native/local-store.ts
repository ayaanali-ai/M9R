/**
 * The M9R Node's local state for the native front door: endpoints seen on this machine, tasks and inbox cursors.
 * One small JSON file under the user's M9R home, written atomically and guarded by a lock directory so a hook and the
 * CLI can never corrupt each other. Everything is synchronous: a hook is a short-lived process.
 *
 * Local first: nothing here needs the network or an account (design section 1, principle 7).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { lapsedPending, ruleCovers, type StandingRule } from "./approval-core";
import { MAX_RESULT_SUMMARY_CHARS, TRUNCATION_MARKER, findByIdempotencyKey, newTask, normalizeHandle, redactSecrets, type Approval, type NewTaskInput, type Task, type TaskDelivery } from "./inbox-core";
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
  kind: "agent.connected" | "session.started" | "task.created" | "task.delivered" | "task.approved" | "task.denied" | "task.expired" | "task.result" | "rule.created" | "rule.revoked" | "mention.double";
  handle?: string;
  taskId?: string;
  text: string;
}

const MAX_EVENTS = 500;

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
}

export interface SessionLink {
  id: string;
  a: { handle: string; sessionId: string; cwd?: string };
  b: { handle: string; sessionId: string; cwd?: string };
  origin: "auto" | "picked";
  createdAt: string;
  updatedAt: string;
}

const emptyState = (): StoreState => ({ version: 1, nextTaskNo: 1, nextSeq: {}, tasks: [], cursors: {}, endpoints: {}, events: [], rules: [], nextRuleNo: 1, sessions: [], links: [], nextLinkNo: 1, identities: [] });

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
}

export function createLocalStore(root: string, deps: LocalStoreDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const statePath = join(root, "state.json");
  const lockPath = join(root, "state.lock");

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
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StoreState;
      return parsed && parsed.version === 1 ? { ...emptyState(), ...parsed } : emptyState();
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
      const tmp = `${statePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(state), "utf8");
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
        const folder = normalizeSessionFolder(input.cwd);
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
      const folder = cwd === undefined ? undefined : normalizeSessionFolder(cwd);
      return readState().sessions.filter((x) => normalizeHandle(x.handle) === normalizeHandle(handle) && (folder === undefined || normalizeSessionFolder(x.cwd) === folder)).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    },

    listEndpoints(): EndpointRecord[] {
      return Object.values(readState().endpoints);
    },

    /** Handles a mention may target: everyone this machine has seen, plus the well-known providers. */
    knownAliases(): string[] {
      const seen = Object.keys(readState().endpoints);
      return [...new Set([...seen, ...Object.values(KNOWN_PROVIDER_HANDLES)])];
    },

    /** Same idempotency key for the same recipient returns the existing task, so a repeated send delivers once. */
    addTask(input: NewTaskInput): { task: Task; created: boolean } {
      const normalizedInput = { ...input, from: normalizeHandle(input.from), to: normalizeHandle(input.to) };
      return update((s) => {
        const existing = findByIdempotencyKey(s.tasks, normalizedInput.to, normalizedInput.idempotencyKey);
        if (existing) return { task: existing, created: false };
        const seq = (s.nextSeq[normalizedInput.to] ?? 0) + 1;
        s.nextSeq[normalizedInput.to] = seq;
        const id = `T${s.nextTaskNo}`;
        s.nextTaskNo += 1;
        const rule = normalizedInput.origin === "agent_initiated" && normalizedInput.standingRuleApplies === undefined ? ruleCovers(s.rules, { from: normalizedInput.from, to: normalizedInput.to, goal: normalizedInput.goal }, now()) : undefined;
        const task = newTask({ ...normalizedInput, standingRuleApplies: normalizedInput.standingRuleApplies ?? !!rule }, { id, seq }, now().toISOString());
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
          if (!t || t.deliveredAt) continue;
          t.deliveredAt = now().toISOString();
          if (sessionId) t.deliveredSession = sessionId;
          pushEvent(s, { kind: "task.delivered", taskId: id, handle: t.to, text: `@${t.to} received ${id}` });
        }
      });
    },

    /** Tasks shown to this agent's session that have no answer yet: what its next finished turn is (probably) the answer to. */
    awaitingAnswerFrom(handle: string, sessionId: string | undefined, withinMs = 60 * 60_000): Task[] {
      const normalizedHandle = normalizeHandle(handle);
      const cutoff = now().getTime() - withinMs;
      return readState().tasks.filter((t) => normalizeHandle(t.to) === normalizedHandle && t.deliveredAt && !t.resultSummary && (!t.deliveredSession || t.deliveredSession === sessionId) && Date.parse(t.deliveredAt) >= cutoff);
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

    /** Ends a session's token early (the person revoked it from the pill, or the session closed). */
    revokeIdentity(sessionId: string): void {
      update((s) => { const at = now().toISOString(); for (const t of s.identities) if (t.sessionId === sessionId && !t.revokedAt) t.revokedAt = at; });
    },

    /** Every link this session takes part in, either side. */
    linksFor(handle: string, sessionId: string, cwd?: string): SessionLink[] {
      const wanted = normalizeSessionRef({ handle, sessionId, cwd });
      const matches = (ref: SessionRef) => normalizeHandle(ref.handle) === wanted.handle
        && ref.sessionId === wanted.sessionId
        && (cwd === undefined || normalizeSessionFolder(ref.cwd) === normalizeSessionFolder(cwd));
      return readState().links.filter((l) => matches(l.a) || matches(l.b));
    },

    /** The session this one is linked to for a given partner agent, if any. */
    linkedSession(handle: string, sessionId: string, partnerHandle: string, cwd?: string): { sessionId: string; cwd?: string } | undefined {
      let links = this.linksFor(handle, sessionId, cwd).filter((x) => normalizeHandle(x.a.handle) === normalizeHandle(partnerHandle) || normalizeHandle(x.b.handle) === normalizeHandle(partnerHandle));
      let allowLegacyFolderless = false;
      if (links.length === 0 && cwd !== undefined) {
        const state = readState();
        const knownSourceFolders = state.sessions.filter((x) => normalizeHandle(x.handle) === normalizeHandle(handle) && x.sessionId === sessionId);
        const requestedFolder = normalizeSessionFolder(cwd);
        allowLegacyFolderless = knownSourceFolders.length === 0 || (knownSourceFolders.length === 1 && normalizeSessionFolder(knownSourceFolders[0].cwd) === requestedFolder);
        if (allowLegacyFolderless) {
          links = state.links.filter((link) => {
            const legacySource = (ref: SessionRef) => normalizeHandle(ref.handle) === normalizeHandle(handle) && ref.sessionId === sessionId && !normalizeSessionFolder(ref.cwd);
            return (legacySource(link.a) && normalizeHandle(link.b.handle) === normalizeHandle(partnerHandle)) || (legacySource(link.b) && normalizeHandle(link.a.handle) === normalizeHandle(partnerHandle));
          });
        }
      }
      if (links.length !== 1) return undefined;
      const wanted = normalizeSessionRef({ handle, sessionId, cwd });
      const sourceMatches = (ref: SessionRef) => normalizeHandle(ref.handle) === wanted.handle
        && ref.sessionId === wanted.sessionId
        && (cwd === undefined || normalizeSessionFolder(ref.cwd) === normalizeSessionFolder(cwd) || (allowLegacyFolderless && !normalizeSessionFolder(ref.cwd)));
      const sourceIsA = sourceMatches(links[0].a);
      const other = sourceIsA ? links[0].b : links[0].a;
      return { sessionId: other.sessionId, ...(other.cwd ? { cwd: other.cwd } : {}) };
    },

    /** Creates or replaces the one link a session may have with a given partner agent. */
    setLink(aInput: SessionRef, bInput: SessionRef, origin: "auto" | "picked"): SessionLink {
      return update((s) => {
        const at = now().toISOString();
        const a = normalizeSessionRef(aInput);
        const b = normalizeSessionRef(bInput);
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
        if (patch.state === "queued" && !t.deliveredAt) {
          t.deliveredAt = now().toISOString();
          pushEvent(s, { kind: "task.delivered", taskId: id, handle: t.to, text: `${id} pushed into @${t.to}'s session` });
        }
        return t;
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

    /**
     * Per session, not per agent: a task addressed to @claude must show in every Claude session that prompts,
     * not just whichever one happens to prompt first. Keying this by handle alone (the original design) meant
     * one Claude session's own hook call could silently advance a SHARED cursor and starve every other open
     * Claude session of ever seeing the notification -- confirmed live 2026-09-22 with several Claude sessions
     * open at once: a task sent by Codex only ever showed in whichever session's hook fired first, and the
     * person had to explicitly ask a different session to "check the M9R inbox" to see it at all. A session
     * with no id (older callers, or an event with no session_id) falls back to the handle-only key so it still
     * gets a cursor, just not one isolated from other id-less callers.
     */
    cursorFor(handle: string, sessionId?: string, cwd?: string): number {
      return readState().cursors[cursorKey(handle, sessionId, cwd)] ?? 0;
    },

    setCursor(handle: string, sessionId: string | undefined, seq: number, cwd?: string): void {
      update((s) => {
        const key = cursorKey(handle, sessionId, cwd);
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
