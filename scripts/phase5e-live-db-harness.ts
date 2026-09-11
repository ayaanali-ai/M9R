/**
 * Phase 5E live-Postgres functional/concurrency harness.
 *
 * Exercises the deployed mission_planning_* schema and RPCs against the
 * real, linked Supabase project — never a fake client. All test data uses a
 * single reserved prefix generated at run time and is fully cleaned up
 * (via cascade delete from the one test Mission row) at the end.
 *
 * SAFETY:
 *   - Defaults to dry-run: prints the plan and exits without touching the
 *     database unless PHASE5E_LIVE_DB_TEST=1 is set.
 *   - Aborts if the project ref visible in NEXT_PUBLIC_SUPABASE_URL does not
 *     match the expected RunLeak project ref.
 *   - Every row this script can write or delete carries the generated
 *     reserved prefix. It never touches any other row.
 *   - Uses the service-role key (server-side only, never printed).
 *
 * Run (dry-run, default):
 *   npx tsx scripts/phase5e-live-db-harness.ts
 *
 * Run (live, against the real database):
 *   PHASE5E_LIVE_DB_TEST=1 npx tsx scripts/phase5e-live-db-harness.ts
 */

import { createClient } from "@supabase/supabase-js";

const EXPECTED_PROJECT_REF = "eymtshaxpkmojsggdtkh";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

function extractProjectRef(url: string): string | null {
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

const projectRef = extractProjectRef(SUPABASE_URL);
const prefix = `phase5e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const wsId = `${prefix}-ws`;
const missionId = `${prefix}-mission`;

type Result = { name: string; group: string; pass: boolean; detail?: string };
const results: Result[] = [];
function record(group: string, name: string, pass: boolean, detail?: string) {
  results.push({ group, name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${group} :: ${name}${detail ? " — " + detail : ""}`);
}

function printPlan() {
  console.log("=== Phase 5E live-Postgres harness plan ===");
  console.log(`target project ref: ${projectRef ?? "(could not be determined from NEXT_PUBLIC_SUPABASE_URL)"}`);
  console.log(`expected project ref: ${EXPECTED_PROJECT_REF}`);
  console.log(`generated test prefix: ${prefix}`);
  console.log(`test workspace_id: ${wsId}`);
  console.log(`test mission_id: ${missionId}`);
  console.log("tables to be written: public.missions (1 row), and via FK cascade only:");
  console.log("  public.mission_planning_leases, mission_planning_worker_attempts,");
  console.log("  mission_planning_worker_attempt_transitions, mission_planning_diagnostics,");
  console.log("  mission_planning_replayable_responses");
  console.log("RPCs to be called: claim_mission_planning_lease, renew_mission_planning_lease,");
  console.log("  release_mission_planning_lease, revoke_mission_planning_lease,");
  console.log("  validate_mission_planning_fence, transition_mission_planning_attempt,");
  console.log("  attach_mission_planning_attempt_provider_request_id,");
  console.log("  create_mission_planning_diagnostic, get_mission_planning_diagnostic");
  console.log("cleanup predicate: delete from public.missions where id = <test mission id>");
  console.log("  (all mission_planning_* rows FK-cascade-delete from this single delete)");
  console.log("cleanup order: single delete on public.missions (cascade handles the rest)");
  console.log("confirmation: every write/delete this script performs is scoped to");
  console.log(`  id/workspace_id values beginning with "${prefix}" — no other row can be affected.`);
  console.log("============================================");
}

async function main() {
  printPlan();

  if (projectRef !== EXPECTED_PROJECT_REF) {
    console.error(`ABORT: project ref mismatch (got ${projectRef}, expected ${EXPECTED_PROJECT_REF}).`);
    process.exit(1);
  }

  if (process.env.PHASE5E_LIVE_DB_TEST !== "1") {
    console.log("\nDry run only (PHASE5E_LIVE_DB_TEST not set to 1). No database operations performed.");
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("ABORT: missing SUPABASE_URL or SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = ANON_KEY ? createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }) : null;

  console.log("\n=== Setting up test Mission row ===");
  const { error: missionInsertErr } = await admin
    .from("missions")
    .insert({ id: missionId, workspace_id: wsId, repository_id: null, current_version: 1 });
  if (missionInsertErr) {
    console.error("ABORT: could not create test Mission row:", missionInsertErr.message);
    process.exit(1);
  }
  console.log(`created public.missions row id=${missionId}`);

  // ---------------------------------------------------------------------
  // FUNCTIONAL: leases
  // ---------------------------------------------------------------------
  const req1 = `${prefix}-preq-1`;

  const claim1 = await admin.rpc("claim_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
    p_owner_id: "worker-a", p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
    p_worker_attempt_id: `${prefix}-attempt-a`, p_worker_id: "worker-a", p_model_configuration_id: "cfg-1",
    p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
    p_correlation_id: "corr-1", p_causation_id: null,
  });
  const row1 = claim1.data?.[0];
  record("functional-lease", "first claim succeeds", !claim1.error && row1?.status === "claimed", JSON.stringify(row1 ?? claim1.error));

  const claim2 = await admin.rpc("claim_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
    p_owner_id: "worker-b", p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
    p_worker_attempt_id: `${prefix}-attempt-b`, p_worker_id: "worker-b", p_model_configuration_id: "cfg-1",
    p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
    p_correlation_id: "corr-2", p_causation_id: null,
  });
  const row2 = claim2.data?.[0];
  record("functional-lease", "competing claim on same slot refused", !claim2.error && row2?.status === "refused" && row2?.reason === "already_leased", JSON.stringify(row2));

  const wrongFenceRenew = await admin.rpc("renew_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: row1.lease.lease_id, p_fencing_token: row1.lease.fencing_token + 999,
    p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
  });
  const wfr = wrongFenceRenew.data?.[0];
  record("functional-lease", "wrong fencing token renew refused", wfr?.status === "refused" && wfr?.reason === "stale_fencing_token", JSON.stringify(wfr));

  const goodRenew = await admin.rpc("renew_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: row1.lease.lease_id, p_fencing_token: row1.lease.fencing_token,
    p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
  });
  const gr = goodRenew.data?.[0];
  record("functional-lease", "renew succeeds inside allowed window", gr?.status === "ok", JSON.stringify(gr));

  const wrongIdRelease = await admin.rpc("release_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: "not-the-real-lease-id", p_fencing_token: row1.lease.fencing_token, p_now: new Date().toISOString(),
  });
  const wir = wrongIdRelease.data?.[0];
  record("functional-lease", "wrong lease ID release refused", wir?.status === "refused" && wir?.reason === "stale_fencing_token", JSON.stringify(wir));

  const goodRelease = await admin.rpc("release_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: row1.lease.lease_id, p_fencing_token: row1.lease.fencing_token, p_now: new Date().toISOString(),
  });
  const grel = goodRelease.data?.[0];
  record("functional-lease", "release succeeds for current holder", grel?.status === "ok", JSON.stringify(grel));

  const staleRelease = await admin.rpc("release_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: row1.lease.lease_id, p_fencing_token: row1.lease.fencing_token, p_now: new Date().toISOString(),
  });
  const sr = staleRelease.data?.[0];
  // Regression test for the defect documented in
  // supabase/migrations/20260727040000_fix_release_mission_planning_lease_status_guard.sql
  // (unpushed corrective migration): a second release with the same
  // lease_id/fencing_token must be refused, not silently accepted.
  record("functional-lease", "stale release (already released) refused", sr?.status === "refused" && (sr?.reason === "already_released" || sr?.reason === "stale_fencing_token"), JSON.stringify(sr));

  const reclaim = await admin.rpc("claim_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
    p_owner_id: "worker-c", p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
    p_worker_attempt_id: `${prefix}-attempt-c`, p_worker_id: "worker-c", p_model_configuration_id: "cfg-1",
    p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
    p_correlation_id: "corr-3", p_causation_id: null,
  });
  const rowReclaim = reclaim.data?.[0];
  record("functional-lease", "reclaim after release succeeds", rowReclaim?.status === "claimed", JSON.stringify(rowReclaim));
  record("functional-lease", "reclaim receives strictly higher fencing token", rowReclaim?.lease?.fencing_token > row1.lease.fencing_token, `old=${row1.lease.fencing_token} new=${rowReclaim?.lease?.fencing_token}`);

  const revoke = await admin.rpc("revoke_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_now: new Date().toISOString(), p_reason: "test-revoke",
  });
  const rv = revoke.data?.[0];
  record("functional-lease", "revoke succeeds through trusted override path", rv?.status === "ok", JSON.stringify(rv));

  const renewAfterRevoke = await admin.rpc("renew_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: rowReclaim.lease.lease_id, p_fencing_token: rowReclaim.lease.fencing_token,
    p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
  });
  const rar = renewAfterRevoke.data?.[0];
  record("functional-lease", "revoked lease cannot renew", rar?.status === "refused" && rar?.reason === "not_active", JSON.stringify(rar));

  const fenceValid = await admin.rpc("validate_mission_planning_fence", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_lease_id: rowReclaim.lease.lease_id, p_fencing_token: rowReclaim.lease.fencing_token,
  });
  record("functional-lease", "fence validation is false for revoked generation", fenceValid.data === false, JSON.stringify(fenceValid));

  // ---------------------------------------------------------------------
  // FUNCTIONAL: attempts
  // ---------------------------------------------------------------------
  const attemptId = rowReclaim.attempt.worker_attempt_id;
  const attemptFence = rowReclaim.lease.fencing_token;

  const legalTransition = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_to_state: "invoking",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: null,
  });
  const lt = legalTransition.data?.[0];
  record("functional-attempt", "legal transition succeeds", lt?.status === "ok", JSON.stringify(lt));

  const staleTransition = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence + 999, p_to_state: "response_received",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: null,
  });
  const st = staleTransition.data?.[0];
  record("functional-attempt", "illegal (stale-fence) transition refused with exact reason", st?.status === "refused" && st?.reason === "stale_fencing_token", JSON.stringify(st));

  const attach1 = await admin.rpc("attach_mission_planning_attempt_provider_request_id", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_provider_request_id: "prov-req-1",
  });
  const a1 = attach1.data?.[0];
  record("functional-attempt", "provider execution ID attachment succeeds", a1?.status === "ok", JSON.stringify(a1));

  const attach2 = await admin.rpc("attach_mission_planning_attempt_provider_request_id", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_provider_request_id: "prov-req-DIFFERENT",
  });
  const a2 = attach2.data?.[0];
  record("functional-attempt", "conflicting provider execution ID attachment refused", a2?.status === "refused", JSON.stringify(a2));

  const terminal1 = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_to_state: "completed",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: "success",
  });
  const t1 = terminal1.data?.[0];
  record("functional-attempt", "terminal transition succeeds", t1?.status === "ok", JSON.stringify(t1));

  const dupTerminal = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_to_state: "completed",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: "success",
  });
  const dt = dupTerminal.data?.[0];
  record("functional-attempt", "duplicate identical terminal write is idempotent", dt?.status === "ok" && dt?.reason === "noop_duplicate_terminal", JSON.stringify(dt));

  const conflictTerminal = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_to_state: "failed",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: "provider_rejected",
  });
  const ct = conflictTerminal.data?.[0];
  record("functional-attempt", "conflicting terminal transition refused", ct?.status === "refused" && ct?.reason === "conflicting_terminal_write", JSON.stringify(ct));

  const terminalCannotTransitionAgain = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_to_state: "invoking",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: null,
  });
  const tcta = terminalCannotTransitionAgain.data?.[0];
  record("functional-attempt", "terminal attempt cannot transition to non-terminal state", tcta?.status === "refused", JSON.stringify(tcta));

  // ---------------------------------------------------------------------
  // FUNCTIONAL: diagnostics
  // ---------------------------------------------------------------------
  const diagRef1 = `${prefix}-diag-1`;
  const diag1 = await admin.rpc("create_mission_planning_diagnostic", {
    p_diagnostic_ref: diagRef1, p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_diagnostic_kind: "invocation_result",
    p_stage: "invocation", p_model_configuration_id: "cfg-1", p_provider_request_id: "prov-req-1",
    p_context_hash: "ctxhash1", p_payload: { ok: true }, p_payload_digest: "digest-1",
    p_redaction_status: "redacted", p_retention_class: "default", p_idempotency_key: `${prefix}-idem-1`,
  });
  const d1 = diag1.data?.[0];
  record("functional-diagnostics", "diagnostic insertion succeeds", d1?.status === "ok" && d1?.reason === "created", JSON.stringify(d1));

  const diag1retry = await admin.rpc("create_mission_planning_diagnostic", {
    p_diagnostic_ref: `${prefix}-diag-1-retry`, p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_diagnostic_kind: "invocation_result",
    p_stage: "invocation", p_model_configuration_id: "cfg-1", p_provider_request_id: "prov-req-1",
    p_context_hash: "ctxhash1", p_payload: { ok: true }, p_payload_digest: "digest-1",
    p_redaction_status: "redacted", p_retention_class: "default", p_idempotency_key: `${prefix}-idem-1`,
  });
  const d1r = diag1retry.data?.[0];
  record("functional-diagnostics", "identical retry is idempotent, same ref returned", d1r?.status === "ok" && d1r?.reason === "idempotent_replay" && d1r?.diagnostic?.diagnostic_ref === diagRef1, JSON.stringify(d1r));

  const diag1conflict = await admin.rpc("create_mission_planning_diagnostic", {
    p_diagnostic_ref: `${prefix}-diag-1-conflict`, p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_diagnostic_kind: "invocation_result",
    p_stage: "invocation", p_model_configuration_id: "cfg-1", p_provider_request_id: "prov-req-1",
    p_context_hash: "ctxhash1", p_payload: { ok: false }, p_payload_digest: "digest-CONFLICT",
    p_redaction_status: "redacted", p_retention_class: "default", p_idempotency_key: `${prefix}-idem-1`,
  });
  const d1c = diag1conflict.data?.[0];
  record("functional-diagnostics", "same identity, different content -> conflict", d1c?.status === "refused" && d1c?.reason === "idempotency_conflict", JSON.stringify(d1c));

  const oversizedPayload = { blob: "x".repeat(40000) };
  const diagOversized = await admin.rpc("create_mission_planning_diagnostic", {
    p_diagnostic_ref: `${prefix}-diag-oversized`, p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req1,
    p_worker_attempt_id: attemptId, p_fencing_token: attemptFence, p_diagnostic_kind: "invocation_result",
    p_stage: "invocation", p_model_configuration_id: "cfg-1", p_provider_request_id: "prov-req-1",
    p_context_hash: "ctxhash1", p_payload: oversizedPayload, p_payload_digest: "digest-oversized",
    p_redaction_status: "redacted", p_retention_class: "default", p_idempotency_key: `${prefix}-idem-oversized`,
  });
  record("functional-diagnostics", "bounded payload constraint enforced (oversized rejected)", !!diagOversized.error, diagOversized.error?.message);

  const serviceRead = await admin.rpc("get_mission_planning_diagnostic", { p_workspace_id: wsId, p_diagnostic_ref: diagRef1 });
  record("functional-diagnostics", "service-role read succeeds", !!serviceRead.data && !serviceRead.error, JSON.stringify(serviceRead.data));

  const crossWorkspaceRead = await admin.rpc("get_mission_planning_diagnostic", { p_workspace_id: "some-other-workspace", p_diagnostic_ref: diagRef1 });
  // A scalar-rowtype SQL function returns an all-null-fields row (not a JS
  // null) when no matching row exists — check the identity field instead.
  record("functional-diagnostics", "cross-workspace lookup returns nothing (rejected)", crossWorkspaceRead.data?.diagnostic_ref == null, JSON.stringify(crossWorkspaceRead.data));

  // ---------------------------------------------------------------------
  // PERMISSIONS
  // ---------------------------------------------------------------------
  if (anon) {
    const anonSelect = await anon.from("mission_planning_leases").select("*").limit(1);
    record("permissions", "anon cannot select protected planning table", !!anonSelect.error || (anonSelect.data?.length === 0 && anonSelect.status === 401) || anonSelect.status === 401 || anonSelect.status === 403, `status=${anonSelect.status} err=${anonSelect.error?.message}`);

    const anonRpc = await anon.rpc("claim_mission_planning_lease", {
      p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: `${prefix}-preq-anon`,
      p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
      p_owner_id: "anon-worker", p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
      p_worker_attempt_id: `${prefix}-attempt-anon`, p_worker_id: "anon-worker", p_model_configuration_id: "cfg-1",
      p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
      p_correlation_id: "corr-anon", p_causation_id: null,
    });
    record("permissions", "anon cannot execute planning RPC", !!anonRpc.error, anonRpc.error?.message);
  } else {
    record("permissions", "anon key not available — anon tests skipped", false, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY missing");
  }
  console.log("[SKIP] permissions :: authenticated-role test — no mechanism in this harness to mint an authenticated-role session; not run, not claimed as passing or failing");

  const serviceRoleSucceeds = !claim1.error && row1?.status === "claimed";
  record("permissions", "service_role can perform intended operations", serviceRoleSucceeds, "proven by functional-lease results above");

  // ---------------------------------------------------------------------
  // CONCURRENCY: genuinely independent sessions via concurrent RPC calls.
  // Each supabase-js .rpc() call is an independent HTTP request through
  // PostgREST, which acquires its own pooled Postgres connection/session
  // for the duration of the call — Promise.all here issues them
  // simultaneously from independent connections, not sequential reuse of
  // one session/transaction.
  // ---------------------------------------------------------------------
  const req2 = `${prefix}-preq-race2`;
  const race2 = await Promise.all(
    ["r2-a", "r2-b"].map((owner) =>
      admin.rpc("claim_mission_planning_lease", {
        p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req2,
        p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
        p_owner_id: owner, p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
        p_worker_attempt_id: `${prefix}-attempt-${owner}`, p_worker_id: owner, p_model_configuration_id: "cfg-1",
        p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
        p_correlation_id: `corr-${owner}`, p_causation_id: null,
      })
    )
  );
  const race2Statuses = race2.map((r) => r.data?.[0]?.status);
  const race2Winners = race2Statuses.filter((s) => s === "claimed").length;
  record("concurrency", "2-way claim race: exactly one winner", race2Winners === 1, JSON.stringify(race2Statuses));
  const race2Losers = race2.filter((r) => r.data?.[0]?.status === "refused");
  record("concurrency", "2-way claim race: all losers get typed refusal", race2Losers.every((r) => r.data?.[0]?.reason === "already_leased"), JSON.stringify(race2Losers.map((r) => r.data?.[0]?.reason)));

  const req3 = `${prefix}-preq-race10`;
  const race10 = await Promise.all(
    Array.from({ length: 10 }, (_, i) => `r10-${i}`).map((owner) =>
      admin.rpc("claim_mission_planning_lease", {
        p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req3,
        p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
        p_owner_id: owner, p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
        p_worker_attempt_id: `${prefix}-attempt-${owner}`, p_worker_id: owner, p_model_configuration_id: "cfg-1",
        p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
        p_correlation_id: `corr-${owner}`, p_causation_id: null,
      })
    )
  );
  const race10Statuses = race10.map((r) => r.data?.[0]?.status);
  const race10Winners = race10Statuses.filter((s) => s === "claimed").length;
  record("concurrency", "10-way claim race: exactly one winner", race10Winners === 1, JSON.stringify(race10Statuses));

  const { data: liveRows } = await admin
    .from("mission_planning_leases")
    .select("planning_request_id, status")
    .eq("workspace_id", wsId)
    .eq("planning_request_id", req3)
    .eq("status", "leased");
  record("concurrency", "exactly one live lease row remains for the raced slot", (liveRows?.length ?? -1) === 1, JSON.stringify(liveRows));

  // Attempt transition race: two sessions racing different terminal states
  // on the same attempt from the same fencing token.
  const raceAttemptTarget = race10.find((r) => r.data?.[0]?.status === "claimed")!.data![0].attempt.worker_attempt_id;
  const raceAttemptFence = race10.find((r) => r.data?.[0]?.status === "claimed")!.data![0].lease.fencing_token;
  const transitionRace = await Promise.all([
    admin.rpc("transition_mission_planning_attempt", { p_worker_attempt_id: raceAttemptTarget, p_fencing_token: raceAttemptFence, p_to_state: "completed", p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: "success" }),
    admin.rpc("transition_mission_planning_attempt", { p_worker_attempt_id: raceAttemptTarget, p_fencing_token: raceAttemptFence, p_to_state: "failed", p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: "provider_rejected" }),
  ]);
  const trStatuses = transitionRace.map((r) => r.data?.[0]);
  const trWinners = trStatuses.filter((r) => r?.status === "ok" && r?.reason !== "noop_duplicate_terminal").length;
  record("concurrency", "attempt terminal-transition race: exactly one wins", trWinners === 1, JSON.stringify(trStatuses.map((r) => ({ status: r?.status, reason: r?.reason }))));

  // Diagnostic idempotency race: concurrent identical writes -> one durable record.
  const diagRaceKey = `${prefix}-idem-race`;
  const diagRace = await Promise.all(
    [1, 2, 3].map((i) =>
      admin.rpc("create_mission_planning_diagnostic", {
        p_diagnostic_ref: `${prefix}-diag-race-${i}`, p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: req3,
        p_worker_attempt_id: null, p_fencing_token: null, p_diagnostic_kind: "invocation_result",
        p_stage: "invocation", p_model_configuration_id: "cfg-1", p_provider_request_id: "prov-req-race",
        p_context_hash: "ctxhash1", p_payload: { ok: true, i }, p_payload_digest: "digest-race",
        p_redaction_status: "redacted", p_retention_class: "default", p_idempotency_key: diagRaceKey,
      })
    )
  );
  const diagRefs = new Set(diagRace.map((r) => r.data?.[0]?.diagnostic?.diagnostic_ref).filter(Boolean));
  record("concurrency", "concurrent identical diagnostic writes -> exactly one durable record", diagRefs.size === 1, JSON.stringify([...diagRefs]));

  // ---------------------------------------------------------------------
  // ROLLBACK
  // ---------------------------------------------------------------------
  // Use a fresh, non-terminal attempt for this test — the earlier `attemptId`
  // is already terminal ("completed"), so an invalid-state transition
  // against it would be caught by the terminal-conflict branch before ever
  // reaching the state CHECK constraint, which would prove the wrong thing.
  const rollbackReq = `${prefix}-preq-rollback`;
  const rollbackClaim = await admin.rpc("claim_mission_planning_lease", {
    p_workspace_id: wsId, p_mission_id: missionId, p_planning_request_id: rollbackReq,
    p_mission_terminal: false, p_request_exists: true, p_request_terminal: false,
    p_owner_id: "worker-rb", p_now: new Date().toISOString(), p_lease_duration_ms: 60000,
    p_worker_attempt_id: `${prefix}-attempt-rb`, p_worker_id: "worker-rb", p_model_configuration_id: "cfg-1",
    p_attempt_kind: "initial_invocation", p_attempt_number: 1, p_context_hash: "ctxhash1",
    p_correlation_id: "corr-rb", p_causation_id: null,
  });
  const rollbackRow = rollbackClaim.data?.[0];
  const rollbackAttemptId = rollbackRow?.attempt?.worker_attempt_id;
  const rollbackFence = rollbackRow?.lease?.fencing_token;

  const badTransition = await admin.rpc("transition_mission_planning_attempt", {
    p_worker_attempt_id: rollbackAttemptId, p_fencing_token: rollbackFence, p_to_state: "not_a_real_state",
    p_now: new Date().toISOString(), p_detail: null, p_outcome_classification: null,
  });
  record("rollback", "invalid transition payload rejected by state CHECK constraint, no partial row", !!badTransition.error, badTransition.error?.message);

  const { data: attemptAfterBad } = await admin.from("mission_planning_worker_attempts").select("state").eq("worker_attempt_id", rollbackAttemptId).single();
  record("rollback", "attempt state unchanged after rejected transition", attemptAfterBad?.state === "claimed", JSON.stringify(attemptAfterBad));

  // ---------------------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------------------
  console.log("\n=== Cleanup ===");
  const { data: toDelete } = await admin.from("missions").select("id, workspace_id").eq("id", missionId);
  console.log("rows eligible for deletion (cascade root):", JSON.stringify(toDelete));

  const { error: cleanupErr } = await admin.from("missions").delete().eq("id", missionId);
  if (cleanupErr) {
    console.error("CLEANUP FAILED:", cleanupErr.message);
  } else {
    console.log(`cleanup: deleted public.missions row id=${missionId} (cascade removed all mission_planning_* rows for this test)`);
  }

  const { data: verifyGone } = await admin.from("missions").select("id").eq("id", missionId);
  const { data: verifyLeasesGone } = await admin.from("mission_planning_leases").select("planning_request_id").eq("workspace_id", wsId);
  console.log(`verify: missions row remaining = ${verifyGone?.length ?? "?"} (expect 0)`);
  console.log(`verify: mission_planning_leases rows remaining for test workspace = ${verifyLeasesGone?.length ?? "?"} (expect 0)`);

  // ---------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------
  console.log("\n=== Summary ===");
  const byGroup = new Map<string, { pass: number; fail: number }>();
  for (const r of results) {
    const g = byGroup.get(r.group) ?? { pass: 0, fail: 0 };
    if (r.pass) g.pass++; else g.fail++;
    byGroup.set(r.group, g);
  }
  for (const [g, c] of byGroup) console.log(`${g}: ${c.pass} passed, ${c.fail} failed`);
  const totalFail = results.filter((r) => !r.pass).length;
  console.log(`TOTAL: ${results.length - totalFail}/${results.length} passed`);
  if (totalFail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("HARNESS ERROR:", err);
  process.exitCode = 1;
});
