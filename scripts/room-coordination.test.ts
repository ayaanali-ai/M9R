import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRoomHandoffRequest, normalizeRoomLeaseRequest } from "../src/lib/rooms/room-coordination.ts";

const eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("task lease requests are bounded and carry a caller-generated idempotency key", () => {
  assert.deepEqual(normalizeRoomLeaseRequest({
    action: "acquire",
    clientEventId: eventId,
    resourceKey: `task:${taskId}`,
    ttlMs: 30_000,
  }), {
    ok: true,
    value: { action: "acquire", clientEventId: eventId, resourceKey: `task:${taskId}`, actorSeatId: null, ttlMs: 30_000, preempt: false },
  });
});

test("room-owner takeover is explicit; invalid scopes, identities, and durations are rejected", () => {
  assert.equal(normalizeRoomLeaseRequest({ action: "acquire", clientEventId: eventId, resourceKey: `task:${taskId}`, ttlMs: 30_000, preempt: true }).ok, true);
  assert.equal(normalizeRoomLeaseRequest({ action: "acquire", clientEventId: eventId, resourceKey: "task:../secret", ttlMs: 30_000 }).ok, false);
  assert.equal(normalizeRoomLeaseRequest({ action: "acquire", clientEventId: eventId, resourceKey: `task:${taskId}`, ttlMs: 4_999 }).ok, false);
  assert.equal(normalizeRoomLeaseRequest({ action: "acquire", clientEventId: "bad", resourceKey: `task:${taskId}`, ttlMs: 30_000 }).ok, false);
  assert.equal(normalizeRoomLeaseRequest({ action: "release", clientEventId: eventId, resourceKey: `task:${taskId}`, preempt: true }).ok, false);
});

test("structured handoffs require a real recipient, explicit proposal context, and response for counters", () => {
  const proposal = normalizeRoomHandoffRequest({
    action: "propose",
    clientEventId: eventId,
    handoffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    taskId,
    recipientActorId: "member:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    context: "Please finish the task after checking the auth edge case.",
    doneCriteria: ["Add the regression test", "Report the test command"],
  });
  assert.equal(proposal.ok, true);
  assert.equal(normalizeRoomHandoffRequest({ action: "propose", clientEventId: eventId, handoffId: eventId, taskId, recipientActorId: "seat:not-a-seat" }).ok, false);
  assert.equal(normalizeRoomHandoffRequest({ action: "counter", clientEventId: eventId, handoffId: eventId, taskId, recipientActorId: "member:dddddddd-dddd-4ddd-8ddd-dddddddddddd" }).ok, false);
  assert.equal(normalizeRoomHandoffRequest({ action: "accept", clientEventId: eventId, handoffId: eventId, taskId, recipientActorId: "member:dddddddd-dddd-4ddd-8ddd-dddddddddddd", context: "silently mutate terms" }).ok, false);
});

test("room leases serialize one holder, expire, and let only the room owner preempt with hand-back state", async () => {
  const { readFileSync } = await import("node:fs");
  const migration = readFileSync(new URL("../supabase/migrations/20260928020000_room_leases.sql", import.meta.url), "utf8");
  assert.match(migration, /create table if not exists public\.m9r_room_leases/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_now := clock_timestamp\(\)/);
  assert.match(migration, /lease_row\.expires_at <= v_now/);
  assert.match(migration, /caller_id <> room_owner_id/);
  assert.match(migration, /p_action is null/);
  assert.match(migration, /p_preempt is null/);
  assert.match(migration, /hashtextextended\(new\.room_id::text, 0\)/);
  assert.match(migration, /requestTtlMs/);
  assert.match(migration, /holder_seat_id uuid references public\.m9r_room_agent_seats\(id\) on delete cascade/);
  assert.match(migration, /preempted_member_id/);
  assert.match(migration, /room\.lease\.acquired/);
  assert.match(migration, /room\.lease\.returned/);
  assert.match(migration, /act_m9r_room_handoff/);
  assert.match(migration, /handoff recipient must answer/);
  assert.match(migration, /room\.lease\.handoff/);
  assert.match(migration, /assigneeActorId/);
  assert.match(migration, /room\.lease\.completed/);
  assert.match(migration, /actor_id is distinct from initiator_actor_id[\s\S]*?not \(caller_id = room_owner_id and p_actor_seat_id is null\)/);
  const roomPage = readFileSync(new URL("../src/app/rooms/[roomId]/page.tsx", import.meta.url), "utf8");
  assert.match(roomPage, /currentActorId === awaitingHandoff\.senderActorId \|\| \(isRoomOwner && !selectedSeatId\)/);
});
