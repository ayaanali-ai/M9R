/**
 * The M9R Node's local state for the native front door: endpoints seen on this machine, tasks and inbox cursors.
 * One small JSON file under the user's M9R home, written atomically and guarded by a lock directory so a hook and the
 * CLI can never corrupt each other. Everything is synchronous: a hook is a short-lived process.
 *
 * Local first: nothing here needs the network or an account (design section 1, principle 7).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lapsedPending, ruleCovers, type StandingRule } from "./approval-core";
import { MAX_RESULT_SUMMARY_CHARS, TRUNCATION_MARKER, findByIdempotencyKey, newTask, redactSecrets, type Approval, type NewTaskInput, type Task, type TaskDelivery } from "./inbox-core";

export interface EndpointRecord {
  handle: string;
  provider: string;
  sessionId?: string;
  cwd?: string;
  lastSeenAt: string;
}

export interface EventRecord {
  at: string;
  kind: "agent.connected" | "session.started" | "task.created" | "task.delivered" | "task.approved" | "task.denied" | "task.expired" | "task.result" | "rule.created" | "rule.revoked";
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
}

const emptyState = (): StoreState => ({ version: 1, nextTaskNo: 1, nextSeq: {}, tasks: [], cursors: {}, endpoints: {}, events: [], rules: [], nextRuleNo: 1 });

const KNOWN_PROVIDER_HANDLES: Readonly<Record<string, string>> = { "claude-code": "claude", claude: "claude", codex: "codex", opencode: "opencode" };

/** `claude-code` is addressed as `@claude`; unknown providers keep a safe slug of their own name. */
export function handleForProvider(provider: string): string {
  const key = provider.toLowerCase();
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

  /** Runs `fn` on the state under the lock and writes the result atomically. */
  function update<T>(fn: (state: StoreState) => T): T {
    acquire();
    try {
      const state = readState();
      const out = fn(state);
      const tmp = `${statePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(state), "utf8");
      renameSync(tmp, statePath);
      return out;
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  return {
    root,

    registerEndpoint(input: { provider: string; sessionId?: string; cwd?: string }): EndpointRecord {
      const handle = handleForProvider(input.provider);
      return update((s) => {
        const previous = s.endpoints[handle];
        const record: EndpointRecord = { handle, provider: input.provider, sessionId: input.sessionId, cwd: input.cwd, lastSeenAt: now().toISOString() };
        s.endpoints[handle] = record;
        if (!previous) pushEvent(s, { kind: "agent.connected", handle, text: `@${handle} connected (${input.provider})` });
        else if (input.sessionId && previous.sessionId !== input.sessionId) pushEvent(s, { kind: "session.started", handle, text: `@${handle} started a new session` });
        return record;
      });
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
      return update((s) => {
        const existing = findByIdempotencyKey(s.tasks, input.to, input.idempotencyKey);
        if (existing) return { task: existing, created: false };
        const seq = (s.nextSeq[input.to] ?? 0) + 1;
        s.nextSeq[input.to] = seq;
        const id = `T${s.nextTaskNo}`;
        s.nextTaskNo += 1;
        const rule = input.origin === "agent_initiated" && input.standingRuleApplies === undefined ? ruleCovers(s.rules, { from: input.from, to: input.to, goal: input.goal }, now()) : undefined;
        const task = newTask({ ...input, standingRuleApplies: input.standingRuleApplies ?? !!rule }, { id, seq }, now().toISOString());
        s.tasks.push(task);
        if (rule) pushEvent(s, { kind: "task.approved", taskId: id, handle: task.to, text: `${id} approved by standing rule ${rule.id}` });
        pushEvent(s, { kind: "task.created", taskId: id, handle: task.to, text: `@${task.from} to @${task.to}: ${task.goal.slice(0, 120)}` });
        return { task, created: true };
      });
    },

    /** Records that these tasks were shown to their target; the first time only. */
    markDelivered(ids: readonly string[]): void {
      if (ids.length === 0) return;
      update((s) => {
        for (const id of ids) {
          const t = s.tasks.find((x) => x.id === id);
          if (!t || t.deliveredAt) continue;
          t.deliveredAt = now().toISOString();
          pushEvent(s, { kind: "task.delivered", taskId: id, handle: t.to, text: `@${t.to} received ${id}` });
        }
      });
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
    snapshot(): { endpoints: EndpointRecord[]; tasks: Task[]; events: EventRecord[]; cursors: Record<string, number> } {
      const s = readState();
      return { endpoints: Object.values(s.endpoints), tasks: s.tasks, events: s.events, cursors: s.cursors };
    },

    getTask(id: string): Task | undefined {
      return readState().tasks.find((t) => t.id === id);
    },

    tasksFrom(handle: string): Task[] {
      return readState().tasks.filter((t) => t.from === handle);
    },

    tasksFor(handle: string): Task[] {
      return readState().tasks.filter((t) => t.to === handle);
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
     * Delivery is once per agent, not once per window: a task addressed to @claude goes to whichever Claude session
     * prompts first, and no later session repeats it. (The session argument is accepted so callers can stay
     * session-aware later, but it is deliberately not part of the key.)
     */
    cursorFor(handle: string, _sessionId?: string): number {
      return readState().cursors[handle] ?? 0;
    },

    setCursor(handle: string, _sessionId: string | undefined, seq: number): void {
      update((s) => {
        if (seq > (s.cursors[handle] ?? 0)) s.cursors[handle] = seq;
      });
    },
  };
}

export type LocalStore = ReturnType<typeof createLocalStore>;

/** `M9R_HOME` overrides the default so tests and separate profiles never touch the real one. */
export function defaultStoreRoot(home: string, env: Record<string, string | undefined> = process.env): string {
  return env.M9R_HOME?.trim() || join(home, ".m9r");
}
