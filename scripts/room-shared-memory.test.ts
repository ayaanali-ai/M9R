import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("room memory reuses workspace_memory_notes with its own scope, not a new memory table", () => {
  const migration = read("supabase/migrations/20261003020000_room_shared_memory.sql");
  // Added to the EXISTING table -- no "create table" for a parallel memory store.
  assert.match(migration, /alter table public\.workspace_memory_notes\s+add column room_id/);
  assert.doesNotMatch(migration, /create table public\.(room|rooms)_memory/i);
  // A note is scoped to a channel or a room, never both.
  assert.match(migration, /workspace_memory_notes_single_scope check \(not \(conversation_id is not null and room_id is not null\)\)/);
  // Dedupe key covers room_id so two different rooms in the same workspace don't collide on identical wording.
  assert.match(migration, /create unique index workspace_memory_dedupe on public\.workspace_memory_notes\(workspace_id, coalesce\(conversation_id::text, ''\), coalesce\(room_id::text, ''\), content_hash\)/);
  // Read authorization is active room membership, not workspace_members -- the guest path.
  assert.match(migration, /room members read their room's shared notes/);
  assert.match(migration, /rm\.user_id = auth\.uid\(\) and rm\.status = 'active'/);
  assert.doesNotMatch(migration.split("room members read their room's shared notes")[1]!.split(";")[0]!, /workspace_members/);
});

test("the save-room-memory RPC checks active room membership before writing, and derives workspace_id from the room (never trusts a caller-supplied one)", () => {
  const migration = read("supabase/migrations/20261003020000_room_shared_memory.sql");
  assert.match(migration, /create function public\.m9r_save_room_memory\(p_room_id uuid, p_actor uuid, p_title text, p_body text, p_content_hash text\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /if not exists \(select 1 from m9r_room_members where room_id = p_room_id and user_id = p_actor and status = 'active'\) then/);
  assert.match(migration, /select workspace_id into ws from m9r_rooms where id = p_room_id/);
  assert.match(migration, /insert into workspace_memory_notes \(workspace_id, room_id, title, body, content_hash, source, author_user_id, reviewed\)/);
  // A room-saved note is live immediately (same as a human's own workspace note), never queued for review.
  assert.match(migration, /values \(ws, p_room_id, p_title, p_body, p_content_hash, 'human', p_actor, true\)/);
});

test("the service layer maps the RPC's error codes to the right HTTP-shaped errors, reusing memoryDatabaseError/normalizeMemoryNote", () => {
  const service = read("src/lib/shared-memory-service.ts");
  assert.match(service, /export async function listRoomMemory\(roomId: string\)/);
  assert.match(service, /export async function saveRoomMemory\(roomId: string, userId: string, raw: unknown\)/);
  assert.match(service, /normalizeMemoryNote\(raw\)/, "reuses the same title/body validation and redaction as workspace notes");
  assert.match(service, /m9r_save_room_memory/);
  assert.match(service, /error\?\.code === "23505"[\s\S]{0,40}duplicate: true/, "a dedupe conflict is reported the same way as the existing workspace save path, not as a 500");
  assert.match(service, /error\?\.code === "42501"[\s\S]{0,80}FORBIDDEN[\s\S]{0,10}403/);
  assert.match(service, /error\?\.code === "P0002"[\s\S]{0,80}NOT_FOUND[\s\S]{0,10}404/);
});

test("the room memory route reads without requiring a workspace account, and writes with a real signed-in user id only", () => {
  const route = read("src/app/api/rooms/[roomId]/memory/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  // GET never calls auth.getUser() / never 401s -- RLS alone decides what a guest can see.
  const getBody = route.split("export async function GET")[1]!.split("export async function POST")[0]!;
  assert.doesNotMatch(getBody, /auth\.getUser/);
  assert.doesNotMatch(getBody, /401/);
  // POST requires a real session and never trusts a client-supplied user id.
  const postBody = route.split("export async function POST")[1]!;
  assert.match(postBody, /auth\.getUser\(\)/);
  assert.match(postBody, /Sign in to save room memory/);
  assert.match(postBody, /saveRoomMemory\(roomId, user\.id, body\)/);
});
