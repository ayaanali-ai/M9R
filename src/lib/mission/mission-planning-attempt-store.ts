/**
 * Durable worker-attempt store — Phase 5D Priority 3.
 * ----------------------------------------------------------------------------
 * Records, per planning attempt, enough state to answer "what was this
 * worker doing, and is it safe to act on it" without re-deriving it from
 * scratch — the durable substrate `mission-planning-recovery.ts` reads.
 *
 * In-memory only (no Postgres here — see docs/PHASE_5D_TRANSACTION_BOUNDARIES.md).
 * Every method is synchronous internally with no `await` between read and
 * write, matching `InMemoryPlanningLeaseStore`'s atomicity argument: two
 * concurrent transition calls raced via `Promise.all` cannot interleave
 * mid-decision.
 *
 * Rules enforced here (not just documented):
 *  - A fencing token is captured at creation and checked on every subsequent
 *    transition call — a fenced-out (stale) worker cannot mutate its own
 *    attempt further.
 *  - Duplicate terminal writes with the SAME terminal state are idempotent —
 *    calling `transition` again with an identical terminal outcome is a
 *    no-op that returns the already-stored attempt, not an error.
 *  - Conflicting terminal writes (a different terminal state on an
 *    already-terminal attempt) are rejected.
 *  - `providerRequestId` may be null at creation and attached later via a
 *    distinct `attachProviderRequestId` call — never required up front.
 *  - `outcome_unknown` is preserved exactly as recorded; this store never
 *    resolves it to success/failure on its own.
 */

export type PlanningAttemptState =
  | "claimed"
  | "invoking"
  | "response_received"
  | "parsing"
  | "validating"
  | "simulating"
  | "repairing"
  | "recording_result"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "superseded"
  | "lease_lost"
  | "outcome_unknown";

export const TERMINAL_ATTEMPT_STATES: readonly PlanningAttemptState[] = [
  "completed",
  "failed",
  "cancelled",
  "stale",
  "superseded",
  "lease_lost",
  "outcome_unknown",
];

export function isTerminalAttemptState(state: PlanningAttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.includes(state);
}

export type PlanningAttemptKind = "initial" | "repair";

export type PlanningAttemptOutcome =
  | "success"
  | "provider_rejected"
  | "transport_failure"
  | "throttled"
  | "outcome_unknown"
  | "cancelled"
  | "stale"
  | "superseded"
  | "lease_lost"
  | null;

export interface PlanningAttemptTransitionRecord {
  toState: PlanningAttemptState;
  at: string;
  detail?: string;
}

export interface PlanningWorkerAttempt {
  workerAttemptId: string;
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  leaseId: string;
  fencingToken: number;
  workerIdentity: string;
  modelConfigurationId: string;
  providerRequestId: string | null;
  attemptKind: PlanningAttemptKind;
  attemptNumber: number;
  state: PlanningAttemptState;
  contextHash: string;
  startedAt: string;
  responseReceivedAt: string | null;
  completedAt: string | null;
  outcome: PlanningAttemptOutcome;
  diagnosticRef: string | null;
  retryMetadata: { transportRetries: number; throttleRetries: number };
  /** Non-null only for `attemptKind: "repair"` — the attempt this repair is bounded-retrying. */
  parentAttemptId: string | null;
  correlationId: string;
  causationId: string | null;
  /** Append-only — every accepted `transition` call pushes exactly one entry. Never rewritten. */
  transitions: PlanningAttemptTransitionRecord[];
}

export interface CreateAttemptInput {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  leaseId: string;
  fencingToken: number;
  workerIdentity: string;
  modelConfigurationId: string;
  attemptKind: PlanningAttemptKind;
  attemptNumber: number;
  contextHash: string;
  parentAttemptId?: string | null;
  correlationId: string;
  causationId?: string | null;
  now: string;
  mintId: () => string;
}

export type TransitionResult =
  | { ok: true; attempt: PlanningWorkerAttempt; noop?: boolean }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "conflicting_terminal_write" };

export class InMemoryPlanningAttemptStore {
  private readonly attempts = new Map<string, PlanningWorkerAttempt>();

  create(input: CreateAttemptInput): PlanningWorkerAttempt {
    const attempt: PlanningWorkerAttempt = {
      workerAttemptId: input.mintId(),
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      workerIdentity: input.workerIdentity,
      modelConfigurationId: input.modelConfigurationId,
      providerRequestId: null,
      attemptKind: input.attemptKind,
      attemptNumber: input.attemptNumber,
      state: "claimed",
      contextHash: input.contextHash,
      startedAt: input.now,
      responseReceivedAt: null,
      completedAt: null,
      outcome: null,
      diagnosticRef: null,
      retryMetadata: { transportRetries: 0, throttleRetries: 0 },
      parentAttemptId: input.parentAttemptId ?? null,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      transitions: [{ toState: "claimed", at: input.now }],
    };
    this.attempts.set(attempt.workerAttemptId, attempt);
    return attempt;
  }

  get(workerAttemptId: string): PlanningWorkerAttempt | null {
    return this.attempts.get(workerAttemptId) ?? null;
  }

  /** All attempts for one planning request, oldest first — repair attempts link back via `parentAttemptId`. */
  listForRequest(workspaceId: string, missionId: string, planningRequestId: string): PlanningWorkerAttempt[] {
    return [...this.attempts.values()]
      .filter((a) => a.workspaceId === workspaceId && a.missionId === missionId && a.planningRequestId === planningRequestId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Non-terminal attempts across the whole store — what `recoverPlanningAttempts` scans. */
  listNonTerminal(): PlanningWorkerAttempt[] {
    return [...this.attempts.values()].filter((a) => !isTerminalAttemptState(a.state));
  }

  /**
   * The core transition call. Checks the caller's fencing token against the
   * attempt's own — captured at creation, never updated — before applying
   * anything. Terminal-write semantics:
   *   - not yet terminal -> requested state: applied normally.
   *   - already terminal, same state requested again: no-op, returns
   *     existing record unchanged (duplicate terminal write, e.g. a retried
   *     network call after the response already landed).
   *   - already terminal, DIFFERENT state requested: rejected — a worker
   *     must never flip a closed attempt to a different terminal outcome.
   */
  transition(
    workerAttemptId: string,
    fencingToken: number,
    toState: PlanningAttemptState,
    now: string,
    opts?: { detail?: string; outcome?: PlanningAttemptOutcome },
  ): TransitionResult {
    const attempt = this.attempts.get(workerAttemptId);
    if (!attempt) return { ok: false, reason: "not_found" };
    if (attempt.fencingToken !== fencingToken) return { ok: false, reason: "stale_fencing_token" };

    if (isTerminalAttemptState(attempt.state)) {
      if (attempt.state === toState) {
        // Idempotent duplicate terminal write — no mutation, no new transition entry.
        return { ok: true, attempt, noop: true };
      }
      return { ok: false, reason: "conflicting_terminal_write" };
    }

    const updated: PlanningWorkerAttempt = {
      ...attempt,
      state: toState,
      outcome: opts?.outcome !== undefined ? opts.outcome : attempt.outcome,
      completedAt: isTerminalAttemptState(toState) ? now : attempt.completedAt,
      responseReceivedAt: toState === "response_received" ? now : attempt.responseReceivedAt,
      transitions: [...attempt.transitions, { toState, at: now, detail: opts?.detail }],
    };
    this.attempts.set(workerAttemptId, updated);
    return { ok: true, attempt: updated };
  }

  /** Attaches a diagnostic ref without forcing a state transition (e.g. right after `storeDiagnostic` succeeds). */
  attachDiagnosticRef(workerAttemptId: string, fencingToken: number, diagnosticRef: string): TransitionResult {
    const attempt = this.attempts.get(workerAttemptId);
    if (!attempt) return { ok: false, reason: "not_found" };
    if (attempt.fencingToken !== fencingToken) return { ok: false, reason: "stale_fencing_token" };
    const updated: PlanningWorkerAttempt = { ...attempt, diagnosticRef };
    this.attempts.set(workerAttemptId, updated);
    return { ok: true, attempt: updated };
  }

  /**
   * `providerRequestId` is only known once the model call is actually in
   * flight (`invokeStructuredPlan` returns it) — this is a distinct
   * "attach" transition rather than a creation-time field, since a crash
   * between claim and invocation must not require guessing it. Preserved
   * once attached — a later call with a different value is rejected rather
   * than silently overwritten, since that would indicate two invocations
   * against one attempt.
   */
  attachProviderRequestId(workerAttemptId: string, fencingToken: number, providerRequestId: string): TransitionResult {
    const attempt = this.attempts.get(workerAttemptId);
    if (!attempt) return { ok: false, reason: "not_found" };
    if (attempt.fencingToken !== fencingToken) return { ok: false, reason: "stale_fencing_token" };
    if (attempt.providerRequestId !== null && attempt.providerRequestId !== providerRequestId) {
      return { ok: false, reason: "conflicting_terminal_write" };
    }
    const updated: PlanningWorkerAttempt = { ...attempt, providerRequestId };
    this.attempts.set(workerAttemptId, updated);
    return { ok: true, attempt: updated };
  }

  recordRetry(workerAttemptId: string, fencingToken: number, kind: "transport" | "throttle"): TransitionResult {
    const attempt = this.attempts.get(workerAttemptId);
    if (!attempt) return { ok: false, reason: "not_found" };
    if (attempt.fencingToken !== fencingToken) return { ok: false, reason: "stale_fencing_token" };
    if (isTerminalAttemptState(attempt.state)) return { ok: false, reason: "conflicting_terminal_write" };
    const updated: PlanningWorkerAttempt = {
      ...attempt,
      retryMetadata:
        kind === "transport"
          ? { ...attempt.retryMetadata, transportRetries: attempt.retryMetadata.transportRetries + 1 }
          : { ...attempt.retryMetadata, throttleRetries: attempt.retryMetadata.throttleRetries + 1 },
    };
    this.attempts.set(workerAttemptId, updated);
    return { ok: true, attempt: updated };
  }
}
