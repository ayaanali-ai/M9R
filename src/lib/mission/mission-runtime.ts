/**
 * Mission runtime — the impure shell around `applyMissionCommand`
 * ----------------------------------------------------------------------------
 * This is the first layer in the Mission domain allowed to do I/O — and it
 * is ONLY allowed to talk to the two injected store interfaces. No database
 * driver, no provider call, no scheduler concern lives here. That boundary is
 * what keeps `applyMissionCommand` testable without infrastructure while
 * still giving it somewhere real to run.
 *
 * `runMissionCommand` composes exactly three steps: look up any prior
 * idempotency outcome, load current state, call the pure handler, persist.
 * The interesting part is what happens when persistence loses a race — see
 * the comment above the retry logic below.
 */

import type { MissionCommand, CommandContext } from "./mission-commands";
import { buildCommandOutcomeRecord, type ApplyCommandResult } from "./mission-command-handler";
import { applyMissionCommand } from "./mission-command-handler";
import { checkIdempotency, type IdempotencyKey, type IdempotencyStore, type IdempotentOutcome } from "./mission-idempotency";
import type { CommandOutcomeRecord } from "./mission-commands";
import { loadMissionProjection, type MissionStore } from "./mission-store";

export interface RunMissionCommandInput {
  missionStore: MissionStore;
  idempotencyStore: IdempotencyStore<CommandOutcomeRecord>;
  command: MissionCommand;
  context: CommandContext;
  idempotencyKey: IdempotencyKey;
  /** Injectable for deterministic tests; passed straight through to the handler. */
  mintEventId?: () => string;
}

async function replayFromIdempotencyRecord(
  input: RunMissionCommandInput,
  outcome: IdempotentOutcome<CommandOutcomeRecord>,
): Promise<ApplyCommandResult> {
  const { projection, version } = await loadMissionProjection(input.missionStore, input.command.missionId);
  return applyMissionCommand({
    current: projection.aggregateVersion > 0 || version > 0 ? projection : null,
    command: input.command,
    context: input.context,
    expectedVersion: version,
    priorOutcome: outcome.result,
    mintEventId: input.mintEventId,
  });
}

/**
 * Run one command end to end: idempotency lookup → load → apply (pure) →
 * persist. Returns exactly what `applyMissionCommand` would return; this
 * function adds no new success or error shape of its own — a caller that
 * already understands `ApplyCommandResult` understands this too.
 */
export async function runMissionCommand(input: RunMissionCommandInput): Promise<ApplyCommandResult> {
  const { missionStore, idempotencyStore, command, context, idempotencyKey } = input;

  // ---- 1. Idempotency lookup -------------------------------------------------
  const idemCheck = await checkIdempotency(idempotencyStore, idempotencyKey);
  const priorOutcome = idemCheck.duplicate ? idemCheck.outcome.result : null;

  // ---- 2. Load current state --------------------------------------------------
  const events = await missionStore.loadEvents(command.missionId);
  const { projection, version } = await loadMissionProjection(missionStore, command.missionId);
  const current = events.length > 0 ? projection : null;

  // ---- 3. Apply (pure) --------------------------------------------------------
  const result = applyMissionCommand({
    current,
    command,
    context,
    expectedVersion: version,
    priorOutcome,
    mintEventId: input.mintEventId,
  });

  if (!result.ok) {
    // A version conflict here means SOMETHING moved between our load and our
    // (about-to-be-attempted) write — but we haven't written yet, so this can
    // only happen if our own `expectedVersion` was already stale at load
    // time, which only occurs if the caller passed a bad idempotency key that
    // masked a real prior state. Nothing further to reconcile; surface it.
    return result;
  }

  if (result.replayed) {
    // A pure replay never needs to touch the store — the prior outcome
    // already reflects what's persisted.
    return result;
  }

  // ---- 4. Persist atomically ---------------------------------------------------
  const append = await missionStore.append({ missionId: command.missionId, expectedVersion: version, events: result.events });

  if (append.ok) {
    // Remember the outcome only after the write actually lands, so a crash
    // between apply and persist never records a promise the store can't back.
    await idempotencyStore.remember({
      key: idempotencyKey,
      missionId: command.missionId,
      commandType: command.type,
      result: buildCommandOutcomeRecord(idempotencyKey, command, result),
      recordedAt: context.timestamp,
      aggregateVersion: result.aggregateVersion,
    });
    return result;
  }

  // ---- 5. Lost the append race ---------------------------------------------------
  // We validated against a version that was current a moment ago, but another
  // caller committed first. Two possibilities, and they get different
  // outcomes on purpose:
  //   (a) that caller was processing THIS EXACT command (a genuine duplicate
  //       submitted concurrently, racing on the same idempotency key) — in
  //       which case its outcome is now recorded, and we must replay it
  //       rather than report a conflict for what is not actually new work;
  //   (b) that caller did something ELSE to this Mission — a real conflict,
  //       and we report it as one rather than silently guessing.
  // The idempotency store, not the mission store, is what tells them apart.
  const recheck = await checkIdempotency(idempotencyStore, idempotencyKey);
  if (recheck.duplicate) {
    return replayFromIdempotencyRecord(input, recheck.outcome);
  }

  return {
    ok: false,
    error: {
      code: "version_conflict",
      missionId: command.missionId,
      expectedVersion: version,
      currentVersion: append.conflict.currentVersion,
      message: append.conflict.message,
    },
  };
}
