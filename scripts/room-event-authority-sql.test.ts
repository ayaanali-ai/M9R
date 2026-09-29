import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("shared-target confirmation preserves owner authority while allowing the owner's active agent seat", () => {
  const guardMigration = read("supabase/migrations/20260928030000_authoritative_room_events.sql");
  const internalMigration = read("supabase/migrations/20260928010000_room_live_feed.sql");
  const actionGuard = guardMigration.match(/if p_kind = 'action' and \(([\s\S]*?)\) then/);

  assert.ok(actionGuard, "generic action events must have an explicit narrow guard");
  assert.match(actionGuard[1], /shared_target\.confirmed/);
  assert.match(actionGuard[1], /p_payload->'owner_confirmed' is distinct from 'true'::jsonb/i);
  assert.match(actionGuard[1], /jsonb_typeof\(p_payload->'target'\) is distinct from 'object'/i);
  assert.match(actionGuard[1], /p_payload->'target' \?& array\['pageGroupId', 'origin', 'path', 'tabRef'\]/i,
    "all four shared target fields must be present");
  assert.match(actionGuard[1], /where key not in \('type', 'owner_confirmed', 'target'\)/i,
    "generic action payloads must reject extra top-level fields");
  assert.doesNotMatch(actionGuard[1], /p_actor_seat_id\s+is\s+not\s+null/i,
    "an owner may attribute the confirmation to their active room agent seat");

  assert.match(internalMigration,
    /if p_payload \? 'owner_confirmed' and not exists \([\s\S]*?r\.id = p_room_id and r\.created_by = caller_id and owner_member\.user_id = caller_id[\s\S]*?owner_member\.id = member_row\.id and owner_member\.role = 'owner' and owner_member\.status = 'active'[\s\S]*?\) then raise exception 'only the room owner can confirm shared browser targets'/i,
    "only the authenticated room creator with active owner membership may confirm");
  assert.match(internalMigration,
    /if p_actor_seat_id is not null and not exists \([\s\S]*?s\.id = p_actor_seat_id and s\.room_id = p_room_id and s\.member_id = member_row\.id and s\.status = 'active'[\s\S]*?\) then raise exception 'agent seat is not owned by the active member'/i,
    "a supplied seat must be active, in this room, and owned by the authenticated member");
});

test("authoritative append requires an exact approved disclosure receipt for every generic agent event", () => {
  const guardMigration = read("supabase/migrations/20260928030000_authoritative_room_events.sql");
  assert.match(guardMigration, /p_actor_seat_id is not null and p_kind <> 'action'/i);
  assert.match(guardMigration, /receipt\.decision = 'approved'/i);
  assert.match(guardMigration, /receipt\.audience in \('room', 'members'\)/i);
  assert.match(guardMigration, /receipt\.payload_digest = encode\(digest\(p_payload::text, 'sha256'\), 'hex'\)/i);
  assert.match(guardMigration, /request\.agent_seat_id = p_actor_seat_id::text/i);
  assert.match(guardMigration, /request\.state = 'approved'/i);
  assert.match(guardMigration, /request\.proposed_text_digest = encode\(digest\(p_payload::text, 'sha256'\), 'hex'\)/i);
  assert.match(guardMigration, /request\.expires_at > now\(\)/i);
  assert.match(guardMigration, /approved disclosure receipt required for agent room event/i);
});

test("event approval hashes PostgreSQL's full JSONB payload and scoped auto-allow creates a receipt", () => {
  const guardMigration = read("supabase/migrations/20260928030000_authoritative_room_events.sql");
  const roomsMigration = read("supabase/migrations/20260926010000_cross_machine_rooms.sql");
  const route = read("src/app/api/rooms/[roomId]/disclosures/route.ts");
  assert.match(guardMigration, /create function public\.request_m9r_room_event_disclosure/i);
  assert.match(guardMigration, /digest\(p_proposed_payload::text, 'sha256'\)/i);
  assert.match(guardMigration, /grant execute on function public\.request_m9r_room_event_disclosure[\s\S]*?to authenticated/i);
  assert.match(route, /normalizeRoomEvent\(value\.proposedEvent\)/);
  assert.match(route, /event\.value\.actorSeatId !== agentSeatId/);
  assert.match(route, /p_proposed_payload: event\.value\.payload/);
  assert.match(roomsMigration, /if coalesce\(allowed, false\) then[\s\S]*?insert into public\.m9r_disclosure_receipts[\s\S]*?'approved'/i);
});
