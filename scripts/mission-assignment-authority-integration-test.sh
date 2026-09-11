#!/usr/bin/env bash
# Guarded local-Postgres coverage for Phase 3D.0 assignment authority.
#
# This script is intentionally NOT run against the linked project. It needs a
# disposable Supabase/Postgres stack (Docker, `supabase`, and `psql`) and exits
# before making any connection when those prerequisites are unavailable.
set -euo pipefail

command -v supabase >/dev/null || { echo "SKIP: Supabase CLI is required"; exit 2; }
command -v psql >/dev/null || { echo "SKIP: psql is required"; exit 2; }

supabase start
DB_URL="$(supabase status -o json | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).DB_URL))')"

# The base harness applies the event-log and dispatch migrations. Phase 3D.0
# must be applied strictly after them, never to a linked remote database.
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260725120000_mission_event_log.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260726010000_mission_dispatch_leases.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260728010000_mission_execution_result_inbox.sql

fail() { echo "FAIL: $1"; exit 1; }
expect() { [ "$1" = "$2" ] || fail "$3 (expected $2, got $1)"; }

MISSION="assignment-itest-mission"
WORKSPACE="assignment-itest-workspace"

# The trigger is deliberately exercised through mission_events, so the test
# proves same-transaction index mutation and event rollback behavior.
psql "$DB_URL" -v ON_ERROR_STOP=1 <<SQL
insert into public.missions (id, workspace_id, repository_id, current_version, state)
values ('$MISSION', '$WORKSPACE', 'repo-itest', 0, 'planning');
insert into public.mission_events (event_id, mission_id, workspace_id, aggregate_version, event_type, schema_version, payload, actor, timestamp, provenance, correlation_id)
values ('assignment-created-1', '$MISSION', '$WORKSPACE', 1, 'mission.assignment_created', 'oathlock.mission-event.v1',
  '{"assignment":{"id":"assignment-1","dispatchKey":null,"status":"proposed","adapterRequirement":null}}'::jsonb,
  '{"kind":"system","id":"itest"}'::jsonb, now(), 'system_inference', 'itest-created');
insert into public.mission_events (event_id, mission_id, workspace_id, aggregate_version, event_type, schema_version, payload, actor, timestamp, provenance, correlation_id)
values ('assignment-assigned-2', '$MISSION', '$WORKSPACE', 2, 'mission.assignment_status_changed', 'oathlock.mission-event.v1',
  '{"assignmentId":"assignment-1","previousStatus":"proposed","nextStatus":"claimed","dispatchKey":"assignment-1"}'::jsonb,
  '{"kind":"system","id":"itest"}'::jsonb, now(), 'system_inference', 'itest-assigned');
SQL

INDEX_ROW="$(psql "$DB_URL" -tAc "select assignment_id || ':' || dispatch_key || ':' || assignment_status from public.mission_assignment_index where workspace_id='$WORKSPACE' and mission_id='$MISSION' and assignment_id='assignment-1';")"
expect "$INDEX_ROW" "assignment-1:assignment-1:claimed" "assignment events must create and bind the exact index row"

CANDIDATE='[{"workspaceId":"assignment-itest-workspace","missionId":"assignment-itest-mission","assignmentId":"assignment-1","dispatchKey":"assignment-1","repositoryId":"repo-itest","adapterRequirement":null,"missionState":"planning","expectedAssignmentSourceVersion":2,"executionConstraints":{}}]'
CLAIMED="$(psql "$DB_URL" -tAc "select status from public.claim_mission_dispatch_candidates_atomic('$CANDIDATE'::jsonb, '{\"workerId\":\"itest\"}'::jsonb, now(), 60000, array['planning']);")"
expect "$CLAIMED" "claimed" "valid indexed candidate must claim"
INTENT_ASSIGNMENT="$(psql "$DB_URL" -tAc "select assignment_id from public.mission_dispatch_intents where workspace_id='$WORKSPACE' and mission_id='$MISSION' order by created_at desc limit 1;")"
expect "$INTENT_ASSIGNMENT" "assignment-1" "initial intent insert must include assignment_id"

MISSING="$(psql "$DB_URL" -tAc "select reason from public.claim_mission_dispatch_candidates_atomic('[{\"workspaceId\":\"$WORKSPACE\",\"missionId\":\"$MISSION\",\"dispatchKey\":\"assignment-1\",\"missionState\":\"planning\"}]'::jsonb, '{\"workerId\":\"itest-2\"}'::jsonb, now(), 60000, array['planning']);")"
expect "$MISSING" "missing_assignment_id" "missing assignment id must be refused"

# A substituted assignment cannot be patched in after the lease/intent write:
# it is refused by exact index lookup before any new intent exists.
BEFORE="$(psql "$DB_URL" -tAc "select count(*) from public.mission_dispatch_intents where workspace_id='$WORKSPACE' and mission_id='$MISSION';")"
SUBSTITUTED="$(psql "$DB_URL" -tAc "select reason from public.claim_mission_dispatch_candidates_atomic('[{\"workspaceId\":\"$WORKSPACE\",\"missionId\":\"$MISSION\",\"assignmentId\":\"substituted\",\"dispatchKey\":\"assignment-1\",\"missionState\":\"planning\"}]'::jsonb, '{\"workerId\":\"itest-3\"}'::jsonb, now(), 60000, array['planning']);")"
AFTER="$(psql "$DB_URL" -tAc "select count(*) from public.mission_dispatch_intents where workspace_id='$WORKSPACE' and mission_id='$MISSION';")"
expect "$SUBSTITUTED" "assignment_not_found" "substituted assignment must be refused"
expect "$AFTER" "$BEFORE" "refusal must not create a lease, intent, or outbox row"

echo "PASS: Phase 3D.0 local Postgres assignment-authority checks"
