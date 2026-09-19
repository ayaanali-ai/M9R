/**
 * Delivery state machine (M9R_NETWORK_SPEC.md section 7.2, locked in M9R_NETWORK_SPEC_LOCK.md A3/A4),
 * derived from evidence M9R already stores: the message row (accepted), the endpoint's liveness (queued),
 * and the Bridge's per-message timing events (everything after that). Nothing here writes anything.
 *
 * Rule that matters most: a state is only ever shown when there is evidence for it. A later stage
 * implies the earlier ones happened (a prompt cannot start on a message the Bridge never received), and
 * those are marked `implied`; nothing is ever derived from absence.
 */

export const DELIVERY_STATES = [
  "accepted", "queued", "delivered_to_node", "delivered_to_session", "processing",
  "completed", "failed", "expired", "rejected", "cancelled",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** `failed` is deliberately not terminal: the spec lets it retry from delivered_to_node. */
export const TERMINAL_STATES: ReadonlySet<DeliveryState> = new Set(["completed", "expired", "rejected", "cancelled"]);

/** The spec's transition table, used to validate any reported or derived step. `failed` may retry. */
export const ALLOWED_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  accepted: ["queued", "delivered_to_node", "rejected", "cancelled", "expired"],
  queued: ["delivered_to_node", "expired", "cancelled"],
  delivered_to_node: ["delivered_to_session", "failed", "expired", "cancelled"],
  delivered_to_session: ["processing", "failed"],
  processing: ["completed", "failed"],
  failed: ["delivered_to_node"],
  completed: [],
  expired: [],
  rejected: [],
  cancelled: [],
};

export type TransitionResult =
  | { ok: true; state: DeliveryState; noop: boolean }
  | { ok: false; state: DeliveryState; error: "invalid_transition" };

/** Repeating the current state is a no-op; anything not in the table is refused and the current state is returned. */
export function applyTransition(current: DeliveryState, to: DeliveryState): TransitionResult {
  if (current === to) return { ok: true, state: current, noop: true };
  if (ALLOWED_TRANSITIONS[current].includes(to)) return { ok: true, state: to, noop: false };
  return { ok: false, state: current, error: "invalid_transition" };
}

export interface TimingEvidence {
  stage: string;
  provider: string | null;
  occurred_at: string;
  at_ms: number;
  /** Which Bridge process reported this. Local Bridges are named `local-<provider>-<id>`. */
  bridge_instance_id?: string | null;
  metadata?: { outcome?: string | null; ledger?: boolean | null; providerEventType?: string | null } | null;
}

export interface DeliveryRecipient {
  provider: string;
  address: string;
  endpointId: string | null;
  live: boolean;
  fidelityLevel: "LIVE_NATIVE" | "RESUMABLE_NATIVE" | "CONSULTATION";
}

export interface TimelineEntry {
  state: DeliveryState;
  at: string;
  attempt: number;
  /** `observed`: the Bridge reported this stage. `derived`: computed from the message row and presence. `implied`: a later stage proves it. */
  basis: "observed" | "derived" | "implied";
  evidence: string;
  failureCode?: string;
  /** Only set on delivered_to_node: true when the Bridge wrote the receipt to its local ledger first, false when it is only the Bridge's memory. */
  persisted?: boolean;
}

/** Evidence that is not a delivery state: the Bridge received the message but chose not to run it this time. */
export interface DeliveryNote {
  at: string;
  evidence: string;
  meaning: string;
}

export interface DeliveryView {
  recipient: { address: string; endpointId: string | null; provider: string };
  state: DeliveryState;
  terminal: boolean;
  attempt: number;
  viaConsultation: boolean;
  pendingUntilTurnBoundary: boolean;
  failureCode: string | null;
  timeline: TimelineEntry[];
  notes: DeliveryNote[];
  /** True when the latest evidence is a decline and nothing has progressed since. The state is unchanged; a human may need to look. */
  declined: boolean;
}

export const DEFAULT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Every local Bridge marks a receipt for each provider a message mentions, not only its own, so a Codex Bridge
 * also reports "claude-code received it". Only the recipient's own Bridge is evidence that the recipient's node
 * got the message. Bridges that do not follow the local naming (cloud Bridges) are accepted as before.
 */
export function bridgeMayReportFor(bridgeInstanceId: string | null | undefined, provider: string): boolean {
  if (!bridgeInstanceId || !bridgeInstanceId.startsWith("local-")) return true;
  return bridgeInstanceId.startsWith(`local-${provider}-`);
}

type Stage = { state: DeliveryState; evidence: string; failureCode?: string };

/** Which delivery state a Bridge timing stage is evidence for. Other stages (session.ready, message.enqueued, report.*) are not delivery states. */
function stageEvidence(event: TimingEvidence): Stage | null {
  switch (event.stage) {
    case "message.received": return { state: "delivered_to_node", evidence: "message.received" };
    case "prompt.started": return { state: "delivered_to_session", evidence: "prompt.started" };
    case "provider.first_event": return { state: "processing", evidence: "provider.first_event" };
    case "turn.completed":
      return event.metadata?.outcome === "failed"
        ? { state: "failed", evidence: "turn.completed", failureCode: "turn_failed" }
        : { state: "completed", evidence: "turn.completed" };
    case "turn.failed":
      return { state: "failed", evidence: "turn.failed", failureCode: event.metadata?.providerEventType === "bridge.restart_interrupted" ? "restart_interrupted" : "turn_failed" };
    default: return null;
  }
}

/** The delivery state a stage is evidence for, or null when the stage is not one. Shared with the Bridge's local ledger so both sides agree. */
export function stateForTimingStage(stage: string, outcome?: string | null): DeliveryState | null {
  return stageEvidence({ stage, provider: null, occurred_at: "", at_ms: 0, metadata: { outcome: outcome ?? null } })?.state ?? null;
}

const FORWARD_ORDER: readonly DeliveryState[] = ["delivered_to_node", "delivered_to_session", "processing", "completed"];

/**
 * Timeline and current state of one message for one recipient.
 *
 * Attempts: a failure closes an attempt; a later `message.received` starts the next one (the spec's failed to
 * delivered_to_node retry). Repeated `message.received` without a failure in between is the Bridge re-offering an
 * uncommitted message, not a retry, and changes nothing.
 */
export function deriveDelivery(input: {
  messageCreatedAt: string;
  recipient: DeliveryRecipient;
  timings: readonly TimingEvidence[];
  now: number;
  ttlMs?: number;
}): DeliveryView {
  const { recipient } = input;
  const ttlMs = input.ttlMs ?? DEFAULT_QUEUE_TTL_MS;
  const timeline: TimelineEntry[] = [{ state: "accepted", at: input.messageCreatedAt, attempt: 1, basis: "derived", evidence: "message stored" }];
  let attempt = 1;
  let state: DeliveryState = "accepted";
  let failureCode: string | null = null;
  let reachedNode = false;

  const events = input.timings
    .filter((event) => (event.provider === recipient.provider || event.provider === null) && bridgeMayReportFor(event.bridge_instance_id, recipient.provider))
    .slice()
    .sort((a, b) => a.at_ms - b.at_ms || a.occurred_at.localeCompare(b.occurred_at));

  const notes: DeliveryNote[] = [];
  let lastWasDecline = false;
  const seenInAttempt = new Set<DeliveryState>();
  const push = (entry: Omit<TimelineEntry, "attempt">) => {
    timeline.push({ ...entry, attempt });
    seenInAttempt.add(entry.state);
    state = entry.state;
  };

  for (const event of events) {
    if (event.stage === "turn.rejected") {
      // Not a failure and not the spec's `rejected` (which is a cloud policy decision at accept): the Bridge
      // logs this whenever it declines to run a message right now (session still starting, conversation paused,
      // loop hard-stop, usage-limit cooldown, full queue). Many of those are re-offered and then succeed.
      notes.push({ at: event.occurred_at, evidence: "turn.rejected", meaning: "The Bridge received this but did not run it this time (session starting, paused, loop-stopped, cooling down or queue full). It may be offered again." });
      lastWasDecline = true;
      continue;
    }
    const stage = stageEvidence(event);
    if (!stage) continue;
    if (stage.state !== "delivered_to_node") lastWasDecline = false;

    if (stage.state === "delivered_to_node") {
      if (state === "failed") {
        attempt += 1;
        seenInAttempt.clear();
        failureCode = null;
      } else if (reachedNode) {
        continue;
      }
      reachedNode = true;
      push({ state: "delivered_to_node", at: event.occurred_at, basis: "observed", evidence: stage.evidence, persisted: event.metadata?.ledger === true });
      continue;
    }

    // A later stage proves the earlier forward states even if their own events were never stored.
    const targetIndex = FORWARD_ORDER.indexOf(stage.state);
    if (targetIndex > 0) {
      for (const earlier of FORWARD_ORDER.slice(0, targetIndex)) {
        if (!seenInAttempt.has(earlier)) {
          push({ state: earlier, at: event.occurred_at, basis: "implied", evidence: `implied by ${stage.evidence}`, ...(earlier === "delivered_to_node" ? { persisted: false as const } : {}) });
          if (earlier === "delivered_to_node") reachedNode = true;
        }
      }
    }
    if (stage.state === "failed") {
      if (state === "failed" || state === "completed") continue;
      failureCode = stage.failureCode ?? "failed";
      if (!reachedNode) {
        push({ state: "delivered_to_node", at: event.occurred_at, basis: "implied", evidence: `implied by ${stage.evidence}`, persisted: false });
        reachedNode = true;
      }
      push({ state: "failed", at: event.occurred_at, basis: "observed", evidence: stage.evidence, failureCode });
      continue;
    }
    if (seenInAttempt.has(stage.state) || state === "completed") continue;
    const step = applyTransition(state, stage.state);
    if (!step.ok) continue;
    push({ state: stage.state, at: event.occurred_at, basis: "observed", evidence: stage.evidence });
  }

  if (!reachedNode) {
    // Nothing from the Bridge yet: waiting, or expired. Both come only from the message age and the recipient's liveness.
    const ageMs = input.now - Date.parse(input.messageCreatedAt);
    if (Number.isFinite(ageMs) && ageMs > ttlMs) {
      push({ state: "expired", at: new Date(Date.parse(input.messageCreatedAt) + ttlMs).toISOString(), basis: "derived", evidence: "24h queue TTL elapsed before the Bridge received it" });
    } else if (!recipient.live) {
      push({ state: "queued", at: input.messageCreatedAt, basis: "derived", evidence: "recipient is not live (no fresh heartbeat)" });
    }
  }

  return {
    recipient: { address: recipient.address, endpointId: recipient.endpointId, provider: recipient.provider },
    state,
    terminal: TERMINAL_STATES.has(state),
    attempt,
    viaConsultation: recipient.fidelityLevel === "CONSULTATION",
    pendingUntilTurnBoundary: recipient.fidelityLevel === "RESUMABLE_NATIVE" && state === "delivered_to_node",
    failureCode: state === "failed" ? failureCode : null,
    timeline,
    notes,
    declined: lastWasDecline && !TERMINAL_STATES.has(state) && state !== "failed",
  };
}
