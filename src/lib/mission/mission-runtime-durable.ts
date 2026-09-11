/**
 * runMissionCommandDurable — the impure shell for the real (Postgres-backed)
 * persistence path.
 * ----------------------------------------------------------------------------
 * This is NOT `runMissionCommand` (mission-runtime.ts) reused with different
 * stores plugged in. That function's two-call shape (persist events, THEN
 * remember the outcome) is exactly the pattern that is unsafe against a real
 * database: two separate calls are two separate transactions, and a crash
 * between them can commit the Mission's events while the idempotency record
 * never lands. `runMissionCommandDurable` instead makes exactly ONE durable
 * write call — `MissionCommandPersistence.applyCommand` — which commits the
 * version check, the event insert, and the outcome record as one Postgres
 * transaction (`apply_mission_command_atomic`).
 *
 * A read-only idempotency pre-check DOES happen here, before computing —
 * not as an optimization, but because `applyMissionCommand`'s idempotency
 * check runs before its existence check (mission-command-handler.ts's
 * documented ordering). Without it, a genuine replay of CreateMission would
 * see `current !== null` (the mission it created last time) and be rejected
 * as "mission_already_exists" instead of recognized as a replay. The
 * atomic RPC remains the sole AUTHORITATIVE decision-maker on whether the
 * write actually happens — this pre-check is read-only and cannot cause a
 * correctness problem if it misses under a race; a miss just falls through
 * to the RPC's own re-check under lock.
 */

import { projectMission } from "./mission-projection";
import { applyMissionCommand, buildCommandOutcomeRecord, type ApplyCommandResult } from "./mission-command-handler";
import { hashCommandPayload, type CommandContext, type MissionCommand } from "./mission-commands";
import type { IdempotencyKey } from "./mission-idempotency";
import type { MissionEvent } from "./mission-events";
import type { MissionId } from "./mission-domain";
import type { MissionCommandPersistence } from "./mission-command-persistence";
import type { CommunicationPolicyConfig } from "./mission-communication-policy";

/** The only capability this function needs from a reader — satisfied by `SupabaseMissionEventReader` or any equivalent. */
export interface MissionEventReader {
  loadEvents(missionId: MissionId): Promise<MissionEvent[]>;
}

export interface RunMissionCommandDurableInput {
  reader: MissionEventReader;
  persistence: MissionCommandPersistence;
  command: MissionCommand;
  context: CommandContext;
  idempotencyKey: IdempotencyKey;
  /**
   * Genesis identity for tenant scoping — required on every command, not
   * just CreateMission, because idempotency-outcome lookups and the durable
   * write are both scoped by workspace (see mission-command-persistence.ts).
   * Callers acting on an existing Mission must supply the SAME workspaceId
   * it was created with; there is no way to derive it here without reading
   * the Mission first, which would reintroduce an extra round trip this
   * function's single-write design is built to avoid.
   */
  workspaceId: string;
  /** Injectable for deterministic tests; passed straight through to the pure handler. */
  mintEventId?: () => string;
  /** Optional caller-owned collaboration policy for bounded surfaces such as the Mission channel. */
  communicationPolicy?: CommunicationPolicyConfig;
}

export async function runMissionCommandDurable(input: RunMissionCommandDurableInput): Promise<ApplyCommandResult> {
  const { reader, persistence, command, context, idempotencyKey, workspaceId } = input;

  const [events, priorOutcome] = await Promise.all([
    reader.loadEvents(command.missionId),
    persistence.lookupOutcome(workspaceId, idempotencyKey),
  ]);
  const projection = projectMission(command.missionId, events);
  const expectedVersion = events.length > 0 ? events[events.length - 1].aggregateVersion : 0;
  const current = events.length > 0 ? projection : null;

  const result = applyMissionCommand({
    current,
    command,
    context,
    expectedVersion,
    priorOutcome,
    mintEventId: input.mintEventId,
    communicationPolicy: input.communicationPolicy,
  });

  if (!result.ok) {
    // Rejected by domain rules (illegal transition, terminal immutability,
    // missing mission, idempotency conflict, ...) before anything was ever
    // proposed to storage. Nothing to persist.
    return result;
  }

  if (result.replayed) {
    // The pre-check found a matching, already-committed outcome. Idempotency
    // records are immutable once written, so this is trustworthy without
    // touching the persistence layer at all.
    return result;
  }

  const outcomeRecord = buildCommandOutcomeRecord(idempotencyKey, command, result);

  const persisted = await persistence.applyCommand({
    missionId: command.missionId,
    workspaceId,
    repositoryId: command.type === "CreateMission" ? (command.repositoryId ?? null) : null,
    idempotencyKey,
    commandType: command.type,
    payloadDigest: hashCommandPayload(command),
    expectedVersion,
    events: result.events,
    result: outcomeRecord,
  });

  switch (persisted.status) {
    case "applied":
      // What we computed is exactly what committed.
      return result;

    case "replayed": {
      // The stored outcome belongs to a DIFFERENT invocation's events than
      // the ones we just (uselessly, as it turns out) computed. Rebuild the
      // projection from the authoritative, already-committed stream rather
      // than trusting our own throwaway computation.
      const freshEvents = await reader.loadEvents(command.missionId);
      const freshProjection = projectMission(command.missionId, freshEvents);
      return {
        ok: true,
        projection: freshProjection,
        events: persisted.result.events,
        aggregateVersion: persisted.aggregateVersion,
        replayed: true,
      };
    }

    case "idempotency_conflict":
      return { ok: false, error: { code: "idempotency_conflict", message: persisted.message } };

    case "version_conflict":
      return {
        ok: false,
        error: {
          code: "version_conflict",
          missionId: command.missionId,
          expectedVersion: persisted.conflict.expectedVersion,
          currentVersion: persisted.conflict.currentVersion,
          message: persisted.conflict.message,
        },
      };

    case "workspace_mismatch":
      // Refused before any event was appended — the RPC's own tenant check
      // fired. Never surfaced as a version_conflict: the caller supplied
      // the wrong workspace, not a stale version.
      return { ok: false, error: { code: "workspace_mismatch", missionId: persisted.missionId, suppliedWorkspaceId: persisted.suppliedWorkspaceId } };
  }
}
