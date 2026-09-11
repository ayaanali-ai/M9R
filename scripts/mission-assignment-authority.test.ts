import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260728010000_mission_execution_result_inbox.sql"), "utf8");

test("assignment-created events synchronously project an internal assignment index", () => {
  assert.match(migration, /create table if not exists public\.mission_assignment_index/i);
  assert.match(migration, /after insert on public\.mission_events/i);
  assert.match(migration, /assignment_index_same_version_conflict/);
  assert.match(migration, /assignment_index_stale_event/);
  assert.match(migration, /assignment_index_missing_assignment/);
  assert.match(migration, /security definer set search_path = ''/i);
  assert.match(migration, /revoke all on public\.mission_assignment_index from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on public\.mission_assignment_index to service_role/i);
  assert.match(migration, /assignment_index_malformed_event/);
});

test("index replay and transition conflicts are explicit, never silently ignored", () => {
  assert.match(migration, /new\.aggregate_version < v_existing\.source_aggregate_version[\s\S]*assignment_index_stale_event/i);
  assert.match(migration, /new\.aggregate_version = v_existing\.source_aggregate_version[\s\S]*assignment_index_same_version_conflict/i);
  assert.match(migration, /assignment_index_missing_assignment/);
  assert.match(migration, /first assignment transition may bind the previously-null dispatch/i);
  assert.match(migration, /v_status <> 'claimed'/);
  assert.match(migration, /v_dispatch_key <> v_existing\.dispatch_key/);
});

test("claim RPC locks the exact indexed assignment before writes", () => {
  assert.match(migration, /select \* into a from public\.mission_assignment_index[\s\S]*for update/i);
  assert.match(migration, /if aid is null then return query select mid,dkey,'refused','missing_assignment_id'/i);
  assert.match(migration, /assignment_dispatch_key_mismatch/);
  assert.match(migration, /adapter_requirement_mismatch/);
  assert.match(migration, /assignment_not_dispatchable/);
  assert.match(migration, /stale_assignment_projection/);
  assert.match(migration, /duplicate_or_already_claimed/);
  assert.match(migration, /insert into public\.mission_dispatch_intents \(workspace_id,mission_id,assignment_id/i);
  assert.doesNotMatch(migration, /claim_mission_dispatch_candidates_atomic_legacy_3d0/);
  assert.doesNotMatch(migration, /set assignment_id = v_assignment_id/);
});

test("claims distinguish candidate substitution and tenant authority failures", () => {
  assert.match(migration, /assignment_workspace_mismatch/);
  assert.match(migration, /assignment_mission_mismatch/);
  assert.match(migration, /assignment_dispatch_key_mismatch/);
  assert.match(migration, /adapter_requirement_mismatch/);
  assert.match(migration, /repository_mismatch/);
  assert.match(migration, /expectedAssignmentSourceVersion/);
});

test("lease, intent, and assignment linkage are one transaction with no post-hoc patch", () => {
  const assignmentCheck = migration.indexOf("select * into a from public.mission_assignment_index");
  const leaseInsert = migration.indexOf("insert into public.mission_dispatch_leases");
  const intentInsert = migration.indexOf("insert into public.mission_dispatch_intents (workspace_id,mission_id,assignment_id");
  assert.ok(assignmentCheck >= 0 && leaseInsert > assignmentCheck && intentInsert > leaseInsert);
  assert.match(migration, /on conflict \(workspace_id,mission_id,dispatch_key\)/i);
  assert.match(migration, /revoke all on function public\.claim_mission_dispatch_candidates_atomic/i);
  assert.match(migration, /grant execute on function public\.claim_mission_dispatch_candidates_atomic[\s\S]*to service_role/i);
});

test("legacy null assignment intents remain readable while new authoritative writes require linkage", () => {
  assert.match(migration, /assignment_id text null/i);
  assert.match(migration, /Legacy intents retain a NULL assignment_id/i);
  assert.match(migration, /if aid is null then return query select mid,dkey,'refused','missing_assignment_id'/i);
});
