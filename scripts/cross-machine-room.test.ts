import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateRoomInviteToken, hashRoomInviteToken, parseRoomInviteEmail, parseRoomName, ROOM_INVITE_TTL_MS } from "@/lib/cross-machine-room-core";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("room names are bounded and normalized; invite emails are normalized and validated", () => {
  assert.deepEqual(parseRoomName("  Browser room  "), { ok: true, value: "Browser room" });
  assert.equal(parseRoomName("  ").ok, false);
  assert.equal(parseRoomName("x".repeat(81)).ok, false);
  assert.equal(parseRoomName("a\nb").ok, false);
  assert.deepEqual(parseRoomInviteEmail(" Person@Example.com "), { ok: true, value: "person@example.com" });
  assert.equal(parseRoomInviteEmail("not-an-email").ok, false);
  assert.equal(ROOM_INVITE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test("room invite credentials are high entropy and only their SHA-256 digest is persisted", () => {
  const first = generateRoomInviteToken();
  const second = generateRoomInviteToken();
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(first, second);
  assert.match(hashRoomInviteToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashRoomInviteToken(first), first);
});

test("cross-machine room migration defines isolated room, member, and invite tables with RLS", () => {
  const migrations = read("supabase/migrations/20260926010000_cross_machine_rooms.sql");
  for (const table of ["m9r_rooms", "m9r_room_members", "m9r_room_invites", "m9r_room_agent_seats", "m9r_room_events", "m9r_disclosure_requests", "m9r_disclosure_receipts"]) {
    assert.match(migrations, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migrations, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migrations, /token_hash text not null unique/);
  assert.match(migrations, /created_by = \(select auth\.uid\(\)\)/);
  assert.match(migrations, /after insert on public\.m9r_rooms/);
  assert.match(migrations, /target_user_id = \(select auth\.uid\(\)\) and exists/);
  assert.doesNotMatch(migrations, /create policy[^;]+on public\.m9r_room_invites for insert to authenticated/i);
  assert.match(migrations, /request_m9r_room_join/);
  assert.match(migrations, /admit_m9r_room_member/);
  assert.match(migrations, /register_m9r_room_agent_seat/);
  assert.match(migrations, /append_m9r_room_event/);
  assert.match(migrations, /active agent seat required/);
});

test("room URLs keep requested members quiet, publish minimized events, and export only authenticated traces", () => {
  const join = read("src/app/api/rooms/[roomId]/join/route.ts");
  const instructions = read("src/app/api/rooms/[roomId]/agent-instructions/route.ts");
  const admit = read("src/app/api/rooms/[roomId]/members/[memberId]/admit/route.ts");
  const events = read("src/app/api/rooms/[roomId]/events/route.ts");
  const eventContract = read("src/lib/rooms/room-events.ts");
  const exportRoute = read("src/app/api/rooms/[roomId]/export/route.ts");
  assert.match(join, /request_m9r_room_join/);
  assert.match(join, /quietUntilInvited: true/);
  assert.match(instructions, /joinEndpoint/);
  assert.match(instructions, /quietUntilInvited: true/);
  assert.match(admit, /admit_m9r_room_member/);
  assert.match(events, /normalizeRoomEvent/);
  assert.match(events, /append_m9r_room_event/);
  assert.match(eventContract, /clientEventId/);
  assert.match(eventContract, /Presence is ephemeral/);
  assert.match(exportRoute, /m9r_room_events/);
  assert.match(exportRoute, /traceCoverage/);
});

test("room activity is durable and ordered while presence stays ephemeral and room-scoped", () => {
  const events = read("src/app/api/rooms/[roomId]/events/route.ts");
  const roomPage = read("src/app/rooms/[roomId]/page.tsx");
  const migration = read("supabase/migrations/20260928010000_room_live_feed.sql");
  assert.match(events, /normalizeRoomEvent/);
  assert.match(events, /client_event_id/);
  assert.match(events, /\.gt\("sequence"/);
  assert.match(roomPage, /postgres_changes/);
  assert.match(roomPage, /presenceState/);
  assert.match(roomPage, /presenceChannel\.track/);
  assert.match(roomPage, /presenceChannel\.untrack/);
  assert.match(migration, /alter publication supabase_realtime add table public\.m9r_room_events/i);
  assert.match(migration, /m9r_room_events_client_event_idx/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /idempotency key was reused for a different event/);
  assert.match(migration, /only the room owner can confirm shared browser targets/);
  assert.match(migration, /room\.lease\.task_completed/);
  assert.match(migration, /realtime\.messages/);
  assert.match(migration, /extension = 'presence'/);
  assert.match(migration, /quiet until admission/i);
});

test("live tab sharing is opt-in, read-only, bounded, and restricted to active room members", () => {
  const liveView = read("src/app/rooms/[roomId]/RoomLiveView.tsx");
  const migration = read("supabase/migrations/20261004042347_room_live_tab_broadcast.sql");
  assert.match(liveView, /getDisplayMedia/);
  assert.match(liveView, /surface !== "browser"/);
  assert.match(liveView, /FRAME_INTERVAL_MS = 333/);
  assert.match(liveView, /MAX_FRAME_BYTES = 30 \* 1024/);
  assert.match(liveView, /MAX_STREAM_MS = 5 \* 60_000/);
  assert.match(liveView, /event: "screen-frame"/);
  assert.match(liveView, /visibilitychange/);
  assert.match(liveView, /Frames are not saved in room history/);
  assert.match(migration, /extension = 'broadcast'/);
  assert.match(migration, /m9r-room-live:/);
  assert.match(migration, /m\.user_id = \(select auth\.uid\(\)\) and m\.status = 'active'/);
  assert.doesNotMatch(migration, /insert into public\.m9r_room_events/i);
});

test("room members, leases, and handoffs expose authenticated, state-checked APIs", () => {
  const members = read("src/app/api/rooms/[roomId]/members/route.ts");
  const leases = read("src/app/api/rooms/[roomId]/leases/route.ts");
  const handoffs = read("src/app/api/rooms/[roomId]/handoffs/route.ts");
  const events = read("src/app/api/rooms/[roomId]/events/route.ts");
  const migration = read("supabase/migrations/20260928020000_room_leases.sql");
  const stageLeaseMigration = read("supabase/migrations/20261005010000_room_stage_leases.sql");
  const roomPage = read("src/app/rooms/[roomId]/page.tsx");
  assert.match(members, /eq\("status", "active"\)/);
  assert.match(members, /agent_label/);
  assert.match(leases, /normalizeRoomLeaseRequest/);
  assert.match(leases, /act_m9r_room_lease/);
  assert.match(handoffs, /normalizeRoomHandoffRequest/);
  assert.match(handoffs, /act_m9r_room_handoff/);
  assert.match(handoffs, /55P03/);
  assert.match(events, /state-checked handoff endpoint/);
  assert.match(migration, /recipient actor.*answer|handoff recipient must answer in turn/i);
  assert.match(migration, /room\.lease\.handoff/);
  assert.match(migration, /'assigneeActorId', recipient_id/);
  assert.match(stageLeaseMigration, /desktop:\[0-9a-f\]/i);
  assert.match(stageLeaseMigration, /window:\[0-9a-f\]/i);
  assert.match(roomPage, /Desktop stage coordination/);
  assert.match(roomPage, /member-reported/);
  assert.match(roomPage, /m9r web stage room-keys/);
});

test("generic room event writes cannot forge authority decisions or machine-action receipts", () => {
  const eventRoute = read("src/app/api/rooms/[roomId]/events/route.ts");
  const exportRoute = read("src/app/api/rooms/[roomId]/export/route.ts");
  const exportProjection = read("src/lib/rooms/room-event-export.ts");
  const eventGuard = read("supabase/migrations/20260928030000_authoritative_room_events.sql");
  const eventContract = read("src/lib/rooms/room-events.ts");
  assert.match(eventContract, /AUTHORITATIVE_EVENT_KINDS/);
  assert.match(eventContract, /requires a purpose-built authority workflow/);
  assert.match(eventRoute, /append_m9r_room_event/);
  assert.match(eventRoute, /Handoffs must use the state-checked handoff endpoint/);
  assert.match(eventGuard, /rename to append_m9r_room_event_internal/i);
  assert.match(eventGuard, /revoke all on function public\.append_m9r_room_event_internal[\s\S]*?from public, anon, authenticated/i);
  assert.match(eventGuard, /p_kind not in \('action', 'post', 'ask', 'reply', 'share', 'task', 'artifact'\)/);
  assert.match(eventGuard, /shared_target\.confirmed/);
  assert.match(eventGuard, /explicit human-owner confirmation/);
  assert.match(eventGuard, /requires a purpose-built authority workflow/);
  assert.match(eventGuard, /grant execute on function public\.append_m9r_room_event[\s\S]*?to authenticated/i);
  assert.match(exportRoute, /projectRoomEventType/);
  assert.match(exportProjection, /Derive exported event types from the server-controlled kind/);
  assert.match(exportProjection, /room\.action\.unverified/);
});

test("room page lets participants see task lease control and answer structured handoffs", () => {
  const roomPage = read("src/app/rooms/[roomId]/page.tsx");
  assert.match(roomPage, /RoomLease/);
  assert.match(roomPage, /Take control/);
  assert.match(roomPage, /Take over lease/);
  assert.match(roomPage, /Release control/);
  assert.match(roomPage, /Accept handoff/);
  assert.match(roomPage, /Counteroffer/);
  assert.match(roomPage, /\/handoffs/);
  assert.match(roomPage, /assigneeActorId/);
});

test("room artifacts are versioned shared documents, not arbitrary generic payloads", () => {
  const roomPage = read("src/app/rooms/[roomId]/page.tsx");
  const artifactContract = read("src/lib/rooms/room-events.ts");
  const artifactProjection = read("src/lib/rooms/room-artifacts.ts");
  const eventRoute = read("src/app/api/rooms/[roomId]/events/route.ts");
  const migration = read("supabase/migrations/20260928010000_room_live_feed.sql");
  assert.match(roomPage, /Shared artifacts/);
  assert.match(roomPage, /Save shared artifact/);
  assert.match(roomPage, /artifactBaseEventId/);
  assert.match(artifactContract, /if \(source\.type === "created"\)[\s\S]*?uuid\(source\.baseEventId\)/);
  assert.match(artifactProjection, /projectRoomArtifacts/);
  assert.match(eventRoute, /error\?\.code === "40001"/);
  assert.match(eventRoute, /changed since you opened it/);
  assert.match(migration, /artifact version changed since it was read/i);
  assert.match(migration, /p_payload->>'baseEventId'[\s\S]*?p_causal_event_ids/);
});

test("room creation requires a workspace host session while room links keep anonymous guest joining", () => {
  const create = read("src/app/api/rooms/route.ts");
  const createPage = read("src/app/rooms/new/page.tsx");
  const roomPage = read("src/app/rooms/[roomId]/page.tsx");
  const invite = read("src/app/api/rooms/[roomId]/invites/route.ts");
  const migration = read("supabase/migrations/20260926010000_cross_machine_rooms.sql");
  assert.match(create, /auth\.getUser\(\)/);
  assert.match(create, /from\("workspace_members"\)/);
  assert.match(create, /from\("m9r_rooms"\)/);
  assert.match(create, /parseRoomName/);
  assert.doesNotMatch(createPage, /ensureGuestSession/);
  assert.match(createPage, /if \(data\.user\.is_anonymous\)/);
  assert.match(createPage, /signOut\(\{ scope: "local" \}\)/);
  assert.match(createPage, /You need an M9R account to open your room/);
  // A brand-new visitor with no session at all gets AuthSessionMissingError from getUser() (it always round-trips to
  // the auth server, unlike getSession()) -- confirmed live on every first visit to this page -- and that must read
  // as the normal signed-out state, not an "unavailable"/reload-the-page failure shown to literally every new visitor.
  assert.match(createPage, /sessionError\.name === "AuthSessionMissingError"/);
  assert.match(roomPage, /ensureGuestSession\(supabase\)/);
  assert.match(roomPage, /\/api\/rooms\/\$\{roomId\}\/join/);
  assert.match(invite, /auth\.getUser\(\)/);
  assert.match(migration, /room_owner_id = caller_id/);
  assert.match(migration, /wm\.role in \('owner', 'admin'\)/);
  assert.match(invite, /parseRoomInviteEmail/);
  assert.match(invite, /hashRoomInviteToken/);
  assert.match(invite, /p_token_hash/);
  assert.match(invite, /p_expires_at/);
  assert.match(invite, /invited_email: invite\.invited_email/);
  assert.doesNotMatch(invite, /\.\.\.data\[0\]/);
  assert.doesNotMatch(invite, /\.insert\([\s\S]*token\s*:/);
});
