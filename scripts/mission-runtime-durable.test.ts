/**
 * runMissionCommandDurable — the single-RPC durable flow, exercised against
 * in-process fakes of MissionEventReader / MissionCommandPersistence (not a
 * real Postgres — see mission-store-supabase.test.ts for the RPC-shape
 * tests, and IMPLEMENTATION_NOTES.md for what remains unverified without a
 * live database).
 *
 * The property under test throughout: exactly ONE call to
 * `persistence.applyCommand` per command attempt — never a separate
 * "append" followed by a separate "remember".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runMissionCommandDurable, type MissionEventReader } from "../src/lib/mission/mission-runtime-durable.ts";
import { resolveCommandContext } from "../src/lib/mission/mission-commands.ts";
import { deriveIdempotencyKey } from "../src/lib/mission/mission-idempotency.ts";
import type { MissionCommand, CommandOutcomeRecord } from "../src/lib/mission/mission-commands.ts";
import type { ApplyCommandPersistenceInput, ApplyCommandPersistenceResult, MissionCommandPersistence } from "../src/lib/mission/mission-command-persistence.ts";
import type { MissionEvent } from "../src/lib/mission/mission-events.ts";
import { CONCURRENCY_CONFLICT_STATUS } from "../src/lib/mission/mission-concurrency.ts";

const MISSION_ID = "m-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx() {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-07-24T00:00:00.000Z" });
}

function keyFor(command: MissionCommand): string {
  return deriveIdempotencyKey({ missionId: command.missionId, commandType: command.type, payload: command });
}

/** In-process reader/persistence pair, honest about a real backing log — used to prove one-RPC-per-command against a real state machine, not just mocked responses. */
class FakeDurableBackend implements MissionEventReader, MissionCommandPersistence {
  private events: MissionEvent[] = [];
  private outcomes = new Map<string, CommandOutcomeRecord>();
  applyCommandCallCount = 0;

  async loadEvents(): Promise<MissionEvent[]> {
    return [...this.events];
  }

  private scopedKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}::${idempotencyKey}`;
  }

  async lookupOutcome(workspaceId: string, idempotencyKey: string): Promise<CommandOutcomeRecord | null> {
    return this.outcomes.get(this.scopedKey(workspaceId, idempotencyKey)) ?? null;
  }

  async applyCommand(input: ApplyCommandPersistenceInput): Promise<ApplyCommandPersistenceResult> {
    this.applyCommandCallCount += 1;

    const existing = this.outcomes.get(this.scopedKey(input.workspaceId, input.idempotencyKey));
    if (existing) {
      if (existing.payloadDigest !== input.payloadDigest) {
        return { status: "idempotency_conflict", message: "reused key, different payload" };
      }
      return { status: "replayed", aggregateVersion: existing.aggregateVersion, result: existing };
    }

    const currentVersion = this.events.length > 0 ? this.events[this.events.length - 1].aggregateVersion : 0;
    if (currentVersion !== input.expectedVersion) {
      return {
        status: "version_conflict",
        conflict: {
          status: CONCURRENCY_CONFLICT_STATUS,
          code: "version_conflict",
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion,
          latestEventCursor: this.events.length > 0 ? this.events[this.events.length - 1].eventId : null,
          message: "stale version",
        },
      };
    }

    this.events.push(...input.events);
    this.outcomes.set(this.scopedKey(input.workspaceId, input.idempotencyKey), input.result);
    return { status: "applied", aggregateVersion: input.result.aggregateVersion, result: input.result };
  }
}

test("a command applies, persists exactly once, and the projection reflects it", async () => {
  const backend = new FakeDurableBackend();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };

  const result = await runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: keyFor(create), workspaceId: 'w', mintEventId });

  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.replayed, false);
    assert.equal(result.projection.state, "draft");
  }
  assert.equal(backend.applyCommandCallCount, 1, "one command must produce exactly one durable write call");
});

test("a sequential replay (same key called again) reports replayed and does not double-persist", async () => {
  const backend = new FakeDurableBackend();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  const key = keyFor(create);

  const first = await runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: key, workspaceId: 'w', mintEventId });
  assert.ok(first.ok);

  const second = await runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: key, workspaceId: 'w', mintEventId });
  assert.ok(second.ok);
  if (second.ok) assert.equal(second.replayed, true);

  assert.equal((await backend.loadEvents()).length, 1, "a replay must never append a second time");
  assert.equal(backend.applyCommandCallCount, 1, "the read-only lookupOutcome pre-check found the prior outcome, so the replay never touches applyCommand at all");
});

test("two concurrent calls with the SAME idempotency key: both lookupOutcome pre-checks miss, but the atomic applyCommand recheck still prevents a double-append", async () => {
  const backend = new FakeDurableBackend();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  const key = keyFor(create);

  const [a, b] = await Promise.all([
    runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: key, workspaceId: 'w', mintEventId }),
    runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: key, workspaceId: 'w', mintEventId }),
  ]);

  assert.ok(a.ok);
  assert.ok(b.ok);
  assert.equal((await backend.loadEvents()).length, 1, "a genuine duplicate must never double-append, even when both lookups race past each other");
  assert.equal(backend.applyCommandCallCount, 2, "both raced past the read-only pre-check, so both reached applyCommand — the atomic layer, not the pre-check, is what prevented the double write");
});

test("an invalid transition never reaches the persistence layer at all", async () => {
  const backend = new FakeDurableBackend();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  await runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: keyFor(create), workspaceId: 'w', mintEventId });

  const bad: MissionCommand = { type: "BeginExecution", missionId: MISSION_ID };
  const result = await runMissionCommandDurable({ reader: backend, persistence: backend, command: bad, context: ctx(), idempotencyKey: keyFor(bad), workspaceId: 'w', mintEventId });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_transition");
  assert.equal(backend.applyCommandCallCount, 1, "the rejected command must not have called applyCommand at all — only the earlier CreateMission did");
});

test("a version conflict from the persistence layer surfaces as version_conflict, not a false replay", async () => {
  const backend = new FakeDurableBackend();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  await runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: keyFor(create), workspaceId: 'w', mintEventId });

  // Simulate a stale read: build a command whose computation will target the
  // right domain transition, but race it by directly appending a
  // conflicting event underneath before the persistence call lands. We do
  // this by driving two genuinely different commands concurrently — the
  // second one's expectedVersion (captured at its own loadEvents call) is
  // stale by the time its applyCommand call runs.
  const planA: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const cancelB: MissionCommand = { type: "CancelMission", missionId: MISSION_ID, reason: { code: "t", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } };

  const [a, b] = await Promise.all([
    runMissionCommandDurable({ reader: backend, persistence: backend, command: planA, context: ctx(), idempotencyKey: keyFor(planA), workspaceId: 'w', mintEventId }),
    runMissionCommandDurable({ reader: backend, persistence: backend, command: cancelB, context: ctx(), idempotencyKey: keyFor(cancelB), workspaceId: 'w', mintEventId }),
  ]);

  const results = [a, b];
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  assert.equal(succeeded.length, 1, "exactly one of two genuinely different racing commands must win");
  assert.equal(failed.length, 1);
  if (failed[0] && !failed[0].ok) assert.equal(failed[0].error.code, "version_conflict");
});

test("a workspace_mismatch from the persistence layer surfaces distinctly — never conflated with version_conflict", () => {
  // Regression for a real audit finding: the durable RPC previously never
  // re-checked an EXISTING Mission's genesis workspace_id against the
  // caller-supplied one (`on conflict (id) do nothing` on the genesis
  // insert meant it was only ever set, never verified again). A caller who
  // simply knew a missionId could mutate it under an unrelated workspace.
  // The RPC now returns a dedicated 'workspace_mismatch' status; this
  // proves the durable shell surfaces it as its own distinct error code,
  // not squeezed into version_conflict's shape.
  class MismatchBackend extends FakeDurableBackend {
    async applyCommand(): Promise<ApplyCommandPersistenceResult> {
      return { status: "workspace_mismatch", missionId: MISSION_ID, suppliedWorkspaceId: "wrong-workspace" };
    }
  }
  const backend = new MismatchBackend();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };

  return runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: keyFor(create), workspaceId: "wrong-workspace", mintEventId }).then((result) => {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "workspace_mismatch");
      if (result.error.code === "workspace_mismatch") {
        assert.equal(result.error.missionId, MISSION_ID);
        assert.equal(result.error.suppliedWorkspaceId, "wrong-workspace");
      }
    }
  });
});
