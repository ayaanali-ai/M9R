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
  for (const table of ["m9r_rooms", "m9r_room_members", "m9r_room_invites"]) {
    assert.match(migrations, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migrations, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migrations, /token_hash text not null unique/);
  assert.match(migrations, /created_by = \(select auth\.uid\(\)\)/);
  assert.match(migrations, /after insert on public\.m9r_rooms/);
  assert.match(migrations, /target_user_id = \(select auth\.uid\(\)\) and exists/);
  assert.doesNotMatch(migrations, /create policy[^;]+on public\.m9r_room_invites for insert to authenticated/i);
});

test("room creation is session and workspace-member scoped; room invitations require room authority and store only a token digest", () => {
  const create = read("src/app/api/rooms/route.ts");
  const invite = read("src/app/api/rooms/[roomId]/invites/route.ts");
  const migration = read("supabase/migrations/20260926010000_cross_machine_rooms.sql");
  assert.match(create, /auth\.getUser\(\)/);
  assert.match(create, /from\("workspace_members"\)/);
  assert.match(create, /from\("m9r_rooms"\)/);
  assert.match(create, /parseRoomName/);
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
