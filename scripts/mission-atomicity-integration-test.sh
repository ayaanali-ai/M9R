#!/usr/bin/env bash
# Local Postgres migration verification harness for the Mission event log
# and dispatch-lease migrations (Phase 4D Part 4 §7/§10).
#
# STATUS: this script has NEVER been executed. This environment has no
# Docker, no Supabase CLI, and no local Postgres (verified via
# `which docker`/`which supabase`/`which psql` — all absent). Every SQL
# change across every Phase 4D part is typechecked and logically reviewed
# only. Do NOT treat any of `apply_mission_command_atomic`,
# `claim_mission_dispatch_candidates_atomic`, or either migration file as
# "database-verified" until a human or CI runner with a real Postgres
# instance actually runs this and confirms every PASS below.
#
# This is a REWRITE of a stale prior version of this script, which called
# `apply_mission_command_atomic` with a 7-argument signature
# (mission_id, key, command_type, digest, expected_version, events, result)
# that has never matched the migration's real 9-argument signature
# (p_mission_id, p_workspace_id, p_idempotency_key, p_command_type,
# p_payload_digest, p_expected_version, p_events, p_result,
# p_repository_id) and used an integer schemaVersion in its sample event
# JSON when the column has been `text` since Phase 4D Part 1. Every call
# below has been corrected to match the CURRENT migration file and the
# CURRENT TypeScript event shape (`mission-events.ts`'s
# `MISSION_EVENT_SCHEMA_VERSION = "oathlock.mission-event.v1"`).
#
# Exact commands to run this on a machine with Docker + the Supabase CLI:
#   npm i -g supabase
#   bash scripts/mission-atomicity-integration-test.sh
#
# Requires: `supabase` CLI, `psql`, Docker running.
set -euo pipefail

command -v supabase >/dev/null || { echo "Supabase CLI not found. Install: npm i -g supabase"; exit 1; }
command -v psql >/dev/null || { echo "psql not found. Install the Postgres client."; exit 1; }

FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES+1)); }
pass() { echo "PASS: $1"; }

echo "== 1. Start a local Postgres and apply BOTH Mission migrations, IN ORDER =="
supabase start
DB_URL="$(supabase status -o json | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).DB_URL))')"
psql "$DB_URL" -f supabase/migrations/20260725120000_mission_event_log.sql
psql "$DB_URL" -f supabase/migrations/20260726010000_mission_dispatch_leases.sql
echo "Both migrations applied cleanly, in order."

MISSION_ID="itest-$(date +%s)"
WORKSPACE_ID="ws-itest-1"
IDEMPOTENCY_KEY="itest-key-$(date +%s)"
# The REAL TypeScript event shape — mission-events.ts's createMissionEvent
# output, including the current TEXT schemaVersion (never an integer).
EVENT_JSON='[{"eventId":"e1","type":"mission.created","missionId":"'"$MISSION_ID"'","aggregateVersion":1,"schemaVersion":"oathlock.mission-event.v1","actor":{"kind":"system","id":"orchestrator"},"reason":null,"correlationId":"c1","causationId":null,"timestamp":"2026-07-25T00:00:00Z","provenance":"system_inference","payload":{"type":"mission.created","goal":"g","repository":"r","workspaceId":"'"$WORKSPACE_ID"'","repositoryId":null}}]'
RESULT_JSON='{"idempotencyKey":"'"$IDEMPOTENCY_KEY"'","payloadDigest":"digest-1","aggregateVersion":1,"events":[]}'

echo "== 2. Genesis Mission creation — current TEXT schemaVersion insertion, matching applyCommand's real 9-arg signature =="
psql "$DB_URL" -c "select status, current_version from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', '$IDEMPOTENCY_KEY', 'CreateMission', 'digest-1', 0,
  '$EVENT_JSON'::jsonb, '$RESULT_JSON'::jsonb, null
);" && pass "genesis apply_mission_command_atomic call succeeded (status should read 'applied' above)" || fail "genesis call failed — check schema_version is TEXT, not integer, in the events table"

echo "== 3. Genesis + single apply landed in all three tables together =="
MISSIONS_COUNT=$(psql "$DB_URL" -tAc "select count(*) from public.missions where id = '$MISSION_ID';")
EVENTS_COUNT=$(psql "$DB_URL" -tAc "select count(*) from public.mission_events where mission_id = '$MISSION_ID';")
OUTCOMES_COUNT=$(psql "$DB_URL" -tAc "select count(*) from public.mission_command_outcomes where workspace_id = '$WORKSPACE_ID' and idempotency_key = '$IDEMPOTENCY_KEY';")
[ "$MISSIONS_COUNT" = "1" ] && [ "$EVENTS_COUNT" = "1" ] && [ "$OUTCOMES_COUNT" = "1" ] \
  && pass "genesis landed in all three tables (missions=1, events=1, outcomes=1)" \
  || fail "expected missions=1/events=1/outcomes=1, got missions=$MISSIONS_COUNT/events=$EVENTS_COUNT/outcomes=$OUTCOMES_COUNT"

STORED_SCHEMA_VERSION=$(psql "$DB_URL" -tAc "select schema_version from public.mission_events where mission_id = '$MISSION_ID' and aggregate_version = 1;")
[ "$STORED_SCHEMA_VERSION" = "oathlock.mission-event.v1" ] \
  && pass "schema_version stored as the real TEXT value, not truncated/cast" \
  || fail "expected schema_version='oathlock.mission-event.v1', got '$STORED_SCHEMA_VERSION'"

echo "== 4. Same-workspace mutation succeeds =="
EVENT2_JSON='[{"eventId":"e2","type":"mission.state_changed","missionId":"'"$MISSION_ID"'","aggregateVersion":2,"schemaVersion":"oathlock.mission-event.v1","actor":{"kind":"system","id":"orchestrator"},"reason":null,"correlationId":"c2","causationId":"e1","timestamp":"2026-07-25T00:01:00Z","provenance":"system_inference","payload":{"type":"mission.state_changed","previousState":"draft","nextState":"planning","resumeTo":null}}]'
RESULT2_JSON='{"idempotencyKey":"itest-key-2-'"$(date +%s)"'","payloadDigest":"digest-2","aggregateVersion":2,"events":[]}'
SAME_WORKSPACE_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', 'itest-key-2', 'BeginPlanning', 'digest-2', 1,
  '$EVENT2_JSON'::jsonb, '$RESULT2_JSON'::jsonb, null
);")
[ "$SAME_WORKSPACE_STATUS" = "applied" ] && pass "same-workspace command applied" || fail "expected 'applied' for a same-workspace command, got '$SAME_WORKSPACE_STATUS'"

echo "== 5. CROSS-WORKSPACE mutation is REJECTED (the Critical tenant-boundary fix — Phase 4D Part 1) =="
CROSS_WORKSPACE_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', 'a-completely-different-workspace', 'itest-key-cross', 'BeginPlanning', 'digest-cross', 2,
  '[]'::jsonb, '{}'::jsonb, null
);")
[ "$CROSS_WORKSPACE_STATUS" = "workspace_mismatch" ] \
  && pass "cross-workspace command correctly refused with 'workspace_mismatch'" \
  || fail "expected 'workspace_mismatch' for a cross-workspace command against an existing Mission, got '$CROSS_WORKSPACE_STATUS'"

echo "== 6. Stale expected_version is rejected as version_conflict =="
STALE_VERSION_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', 'itest-key-stale', 'BeginPlanning', 'digest-stale', 0,
  '[]'::jsonb, '{}'::jsonb, null
);")
[ "$STALE_VERSION_STATUS" = "version_conflict" ] && pass "stale expected_version correctly rejected" || fail "expected 'version_conflict', got '$STALE_VERSION_STATUS'"

echo "== 7. Idempotent retry: same key + same payload digest replays, never double-applies =="
RETRY_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', '$IDEMPOTENCY_KEY', 'CreateMission', 'digest-1', 0,
  '$EVENT_JSON'::jsonb, '$RESULT_JSON'::jsonb, null
);")
[ "$RETRY_STATUS" = "replayed" ] && pass "identical retry correctly replayed, not re-applied" || fail "expected 'replayed', got '$RETRY_STATUS'"
EVENTS_COUNT_AFTER_RETRY=$(psql "$DB_URL" -tAc "select count(*) from public.mission_events where mission_id = '$MISSION_ID';")
[ "$EVENTS_COUNT_AFTER_RETRY" = "2" ] && pass "retry did not append a duplicate event (still 2 total)" || fail "expected 2 events after retry, got $EVENTS_COUNT_AFTER_RETRY"

echo "== 8. Conflicting retry: same key, DIFFERENT payload digest, is refused as idempotency_conflict =="
CONFLICT_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', '$IDEMPOTENCY_KEY', 'CreateMission', 'a-totally-different-digest', 0,
  '[]'::jsonb, '{}'::jsonb, null
);")
[ "$CONFLICT_STATUS" = "idempotency_conflict" ] && pass "reused key with a different payload correctly refused" || fail "expected 'idempotency_conflict', got '$CONFLICT_STATUS'"

echo "== 9. Event ordering: aggregate_version is strictly increasing and gapless for this mission =="
ORDERING_OK=$(psql "$DB_URL" -tAc "
  select bool_and(gap = 1) from (
    select aggregate_version - lag(aggregate_version) over (order by aggregate_version) as gap
    from public.mission_events where mission_id = '$MISSION_ID'
  ) t where gap is not null;
")
[ "$ORDERING_OK" = "t" ] && pass "event ordering is strictly sequential, no gaps" || fail "expected strictly sequential aggregate_version, got gap check = '$ORDERING_OK'"

echo "== 10. Projection write: replaying the raw stored events reconstructs the same Mission the TypeScript projection would report =="
cat <<'NODE_EOF' > /tmp/mission_projection_check.mjs
import { projectMission } from "../src/lib/mission/mission-projection.ts";
// A human/CI runner should load the mission_events rows for MISSION_ID via
// pg, map each row back into a MissionEvent, and assert projectMission(...)
// reports state:"planning", aggregateVersion:2, complete:true. Left as a
// documented manual step rather than embedded psql->Node piping here, since
// this script has no real database connection to test that piping against.
NODE_EOF
echo "Manual step: load mission_events for $MISSION_ID via your Postgres client of choice, map rows to MissionEvent, and confirm projectMission(...) reports state=planning, aggregateVersion=2, complete=true."

echo "== 11. Dispatch lease migration: claim_mission_dispatch_candidates_atomic exists and is callable =="
FUNC_EXISTS=$(psql "$DB_URL" -tAc "select count(*) from pg_proc where proname = 'claim_mission_dispatch_candidates_atomic';")
[ "$FUNC_EXISTS" != "0" ] && pass "claim_mission_dispatch_candidates_atomic exists after applying 20260726010000" || fail "claim_mission_dispatch_candidates_atomic missing — dispatch lease migration did not apply cleanly"

echo "== 12. Process-handle persistence: attachProcessHandle's underlying column accepts a JSONB handle =="
# mission-scheduler-store-supabase.ts's attachProcessHandle writes directly
# to the dispatch intents table's process_handle jsonb column — confirmed
# structurally (column exists, accepts jsonb) rather than through the RPC,
# since attaching a handle is a direct table update, not a security-definer
# function call.
HANDLE_COLUMN_EXISTS=$(psql "$DB_URL" -tAc "select count(*) from information_schema.columns where table_name = 'mission_dispatch_intents' and column_name = 'process_handle';")
[ "$HANDLE_COLUMN_EXISTS" != "0" ] && pass "mission_dispatch_intents.process_handle column exists" || fail "process_handle column missing from mission_dispatch_intents"

echo "== 13. Evidence provenance events (Phase 4D Part 4 §7) are accepted by the event_type check constraint =="
EVIDENCE_EVENT_JSON='[{"eventId":"e3","type":"mission.evidence_recorded","missionId":"'"$MISSION_ID"'","aggregateVersion":3,"schemaVersion":"oathlock.mission-event.v1","actor":{"kind":"system","id":"orchestrator"},"reason":null,"correlationId":"c3","causationId":"e2","timestamp":"2026-07-25T00:02:00Z","provenance":"system_inference","payload":{"record":{"id":"ev-1","missionId":"'"$MISSION_ID"'","assignmentId":null,"producerParticipantId":null,"producerKind":"system","executionId":null,"dispatchKey":null,"provider":null,"kind":"test_result","source":"itest","lifecycle":"attached","availability":"available","integrity":null,"supersededByEvidenceId":null,"createdAt":"2026-07-25T00:02:00Z","updatedAt":"2026-07-25T00:02:00Z"}}}]'
RESULT3_JSON='{"idempotencyKey":"itest-key-evidence","payloadDigest":"digest-evidence","aggregateVersion":3,"events":[]}'
EVIDENCE_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', 'itest-key-evidence', 'RecordEvidence', 'digest-evidence', 2,
  '$EVIDENCE_EVENT_JSON'::jsonb, '$RESULT3_JSON'::jsonb, null
);")
[ "$EVIDENCE_STATUS" = "applied" ] && pass "mission.evidence_recorded accepted by the event_type check constraint" || fail "expected 'applied' for an evidence_recorded event, got '$EVIDENCE_STATUS' — check the constraint includes it"

echo "== 14. Planner (Phase 5A) events are still accepted, unaffected by later phases =="
PLAN_EVENT_EXISTS=$(psql "$DB_URL" -tAc "select count(*) from pg_constraint c join pg_class t on c.conrelid = t.oid where t.relname = 'mission_events' and pg_get_constraintdef(c.oid) like '%mission.plan_proposal_created%';")
[ "$PLAN_EVENT_EXISTS" != "0" ] && pass "mission.plan_proposal_created still present in the event_type constraint" || fail "mission.plan_proposal_created missing from the event_type constraint"

echo "== 14b. Phase 5B model-planning-request events are accepted by the event_type check constraint =="
MODEL_PLAN_EVENT_JSON='[{"eventId":"e4","type":"mission.model_plan_request_created","missionId":"'"$MISSION_ID"'","aggregateVersion":4,"schemaVersion":"oathlock.mission-event.v1","actor":{"kind":"system","id":"orchestrator"},"reason":null,"correlationId":"c4","causationId":"e3","timestamp":"2026-07-25T00:03:00Z","provenance":"system_inference","payload":{"record":{"id":"preq-1","missionId":"'"$MISSION_ID"'","targetPlanVersion":1,"kind":"proposal","basePlanId":null,"status":"requested","modelConfigurationId":"planner-config-1","contextHash":"hash-1","attemptCount":0,"maxAttempts":1,"createdAt":"2026-07-25T00:03:00Z","startedAt":null,"completedAt":null,"correlationId":"c4","causationId":"e3","idempotencyKey":"preq-1","redactedDiagnosticRef":null,"finalOutcome":null,"resultingPlanId":null}}}]'
RESULT4_JSON='{"idempotencyKey":"itest-key-model-plan","payloadDigest":"digest-model-plan","aggregateVersion":4,"events":[]}'
MODEL_PLAN_STATUS=$(psql "$DB_URL" -tAc "select status from public.apply_mission_command_atomic(
  '$MISSION_ID', '$WORKSPACE_ID', 'itest-key-model-plan', 'RequestModelPlanning', 'digest-model-plan', 3,
  '$MODEL_PLAN_EVENT_JSON'::jsonb, '$RESULT4_JSON'::jsonb, null
);")
[ "$MODEL_PLAN_STATUS" = "applied" ] && pass "mission.model_plan_request_created accepted by the event_type check constraint" || fail "expected 'applied' for a model_plan_request_created event, got '$MODEL_PLAN_STATUS' — check the constraint includes it"

echo "== 15. RLS / service-role assumptions: anon and authenticated are refused; service_role succeeds =="
psql "$DB_URL" -c "set role anon; select * from public.mission_events limit 1;" \
  && fail "anon could read mission_events directly" \
  || pass "anon refused select on mission_events"

psql "$DB_URL" -c "set role authenticated; select public.apply_mission_command_atomic('x','y','z','CreateMission','d',0,'[]'::jsonb,'{}'::jsonb, null);" \
  && fail "authenticated could call apply_mission_command_atomic" \
  || pass "authenticated refused execute on apply_mission_command_atomic"

echo "== 16. Transaction rollback fault injection: an aggregate_version mismatch inside the loop rolls back EVERYTHING, including genesis =="
MISSION_ID_FAULT="itest-fault-$(date +%s)"
BAD_EVENT_JSON='[{"eventId":"ef1","type":"mission.created","missionId":"'"$MISSION_ID_FAULT"'","aggregateVersion":99,"schemaVersion":"oathlock.mission-event.v1","actor":{"kind":"system","id":"orchestrator"},"reason":null,"correlationId":"cf1","causationId":null,"timestamp":"2026-07-25T00:00:00Z","provenance":"system_inference","payload":{"type":"mission.created","goal":"g","repository":"r","workspaceId":"ws-fault","repositoryId":null}}]'
psql "$DB_URL" -c "select public.apply_mission_command_atomic('$MISSION_ID_FAULT','ws-fault','fault-key','CreateMission','d',0,'$BAD_EVENT_JSON'::jsonb,'{}'::jsonb, null);" \
  && fail "the version-mismatch assertion did not raise" \
  || pass "function raised as expected on aggregate_version mismatch"

ROLLBACK_MISSIONS=$(psql "$DB_URL" -tAc "select count(*) from public.missions where id = '$MISSION_ID_FAULT';")
[ "$ROLLBACK_MISSIONS" = "0" ] && pass "genesis insert rolled back too — no orphaned missions row" || fail "expected 0 missions rows after rollback, got $ROLLBACK_MISSIONS (the genesis insert did NOT roll back with the rest of the transaction)"

echo ""
echo "== Summary =="
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED. Only after seeing this line for a real run may the SQL be described as database-verified."
else
  echo "$FAILURES CHECK(S) FAILED. Do NOT describe the SQL as database-verified."
fi

echo ""
echo "== Compensating / down procedure (manual, LOCAL test database only) =="
cat <<'EOF'
No down migration exists for either Mission migration, matching this repo's
existing convention (no migration under supabase/migrations ships a paired
down script). To reset a local test database:

  drop function if exists public.apply_mission_command_atomic(text, text, text, text, text, integer, jsonb, jsonb, text);
  drop function if exists public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[]);
  drop table if exists public.mission_dispatch_intents;
  drop table if exists public.mission_command_outcomes;
  drop table if exists public.mission_events;
  drop table if exists public.missions;

Run this manually against the LOCAL test database only — never against a
database holding real Mission history, since it is destructive and
irreversible. (Verify claim_mission_dispatch_candidates_atomic's real
parameter list in 20260726010000_mission_dispatch_leases.sql before running
the drop — it is written here from the migration file at time of writing
and should be re-checked, not trusted blindly, exactly like everything
else this script checks.)
EOF
