/**
 * Phase 5E live-adapter harness — exercises the production Supabase-backed
 * adapter CLASSES (SupabaseMissionPlanningLeaseStore,
 * SupabaseMissionPlanningAttemptStore, SupabasePlanningDiagnosticsStore)
 * against the real linked Supabase project, not raw RPC calls and not a
 * fake client. Kept as a SEPARATE result count from
 * phase5e-live-db-harness.ts (direct RPC) and the fake-client unit tests.
 *
 * Same safety model as phase5e-live-db-harness.ts: dry-run by default,
 * requires PHASE5E_LIVE_DB_TEST=1, aborts on project-ref mismatch, reserved
 * test prefix, cascade-delete cleanup via the one test Mission row.
 *
 * Run (live):
 *   PHASE5E_LIVE_DB_TEST=1 npx tsx scripts/phase5e-live-adapter-harness.ts
 */

import { createClient } from "@supabase/supabase-js";
import { SupabaseMissionPlanningLeaseStore } from "../src/lib/mission/mission-planning-lease-store-supabase";
import { SupabaseMissionPlanningAttemptStore } from "../src/lib/mission/mission-planning-attempt-store-supabase";
import { SupabasePlanningDiagnosticsStore } from "../src/lib/mission/mission-planning-diagnostics-store-supabase";

const EXPECTED_PROJECT_REF = "eymtshaxpkmojsggdtkh";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function extractProjectRef(url: string): string | null {
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

const projectRef = extractProjectRef(SUPABASE_URL);
const prefix = `phase5e-adapter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const wsId = `${prefix}-ws`;
const missionId = `${prefix}-mission`;

type Result = { group: string; name: string; pass: boolean; detail?: string };
const results: Result[] = [];
function record(group: string, name: string, pass: boolean, detail?: string) {
  results.push({ group, name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${group} :: ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log("=== Phase 5E live-ADAPTER harness plan ===");
  console.log(`target project ref: ${projectRef}`);
  console.log(`test prefix: ${prefix}`);
  console.log("adapters under test: SupabaseMissionPlanningLeaseStore, SupabaseMissionPlanningAttemptStore, SupabasePlanningDiagnosticsStore");
  console.log("cleanup: single delete on public.missions cascades all mission_planning_* rows");
  console.log("============================================");

  if (projectRef !== EXPECTED_PROJECT_REF) {
    console.error(`ABORT: project ref mismatch (got ${projectRef}).`);
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

  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const leaseStore = new SupabaseMissionPlanningLeaseStore(client);
  const attemptStore = new SupabaseMissionPlanningAttemptStore(client);
  const diagStore = new SupabasePlanningDiagnosticsStore(client);

  console.log("\n=== Setting up test Mission row ===");
  const { error: missionErr } = await client.from("missions").insert({ id: missionId, workspace_id: wsId, repository_id: null, current_version: 1 });
  if (missionErr) {
    console.error("ABORT: could not create test Mission row:", missionErr.message);
    process.exit(1);
  }
  console.log(`created public.missions row id=${missionId}`);

  const req1 = `${prefix}-preq-1`;
  const now = new Date().toISOString();

  // --- lease adapter: claim, argument names, return shape ---
  const claim = await leaseStore.claim({
    workspaceId: wsId, missionId, planningRequestId: req1,
    ownerId: "worker-a", now, leaseDurationMs: 60000,
    workerAttemptId: `${prefix}-attempt-a`, workerId: "worker-a", modelConfigurationId: "cfg-1",
    attemptKind: "initial_invocation", attemptNumber: 1, contextHash: "ctxhash1", correlationId: "corr-1", causationId: null,
  });
  record("adapter-lease", "claim() succeeds via adapter, exact live return shape", claim.ok === true, JSON.stringify(claim));
  if (!claim.ok) { console.error("ABORT: setup claim failed"); process.exit(1); }

  record("adapter-lease", "fencingToken is a JS number with full precision", typeof claim.lease.fencingToken === "number" && claim.lease.fencingToken === 1, String(claim.lease.fencingToken));
  record("adapter-lease", "timestamps decoded as ISO strings", typeof claim.lease.acquiredAt === "string" && !Number.isNaN(Date.parse(claim.lease.acquiredAt)), claim.lease.acquiredAt);
  record("adapter-lease", "nullable fields decoded correctly (renewedAt null before renew)", claim.lease.renewedAt === null, String(claim.lease.renewedAt));

  const claimAgain = await leaseStore.claim({
    workspaceId: wsId, missionId, planningRequestId: req1,
    ownerId: "worker-b", now, leaseDurationMs: 60000,
    workerAttemptId: `${prefix}-attempt-b`, workerId: "worker-b", modelConfigurationId: "cfg-1",
    attemptKind: "initial_invocation", attemptNumber: 1, contextHash: "ctxhash1", correlationId: "corr-2", causationId: null,
  });
  record("adapter-lease", "competing claim mapped to typed already_leased refusal", claimAgain.ok === false && claimAgain.reason === "already_leased", JSON.stringify(claimAgain));

  const renew = await leaseStore.renew({ workspaceId: wsId, missionId, planningRequestId: req1, leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken, now: new Date().toISOString(), leaseDurationMs: 60000 });
  record("adapter-lease", "renew() succeeds, renewedAt populated", renew.ok === true && renew.lease.renewedAt !== null, JSON.stringify(renew));

  const staleRenew = await leaseStore.renew({ workspaceId: wsId, missionId, planningRequestId: req1, leaseId: claim.lease.leaseId, fencingToken: 999999, now: new Date().toISOString(), leaseDurationMs: 60000 });
  record("adapter-lease", "unknown refusal reason stays explicit (stale_fencing_token)", staleRenew.ok === false && staleRenew.reason === "stale_fencing_token", JSON.stringify(staleRenew));

  const release = await leaseStore.release(wsId, missionId, req1, claim.lease.leaseId, claim.lease.fencingToken, new Date().toISOString());
  record("adapter-lease", "release() succeeds via adapter", release.ok === true, JSON.stringify(release));

  const staleRelease = await leaseStore.release(wsId, missionId, req1, claim.lease.leaseId, claim.lease.fencingToken, new Date().toISOString());
  record("adapter-lease", "regression: stale release now refused via adapter (fix applied)", staleRelease.ok === false && staleRelease.reason === "already_released", JSON.stringify(staleRelease));

  // --- attempt adapter ---
  const reclaim = await leaseStore.claim({
    workspaceId: wsId, missionId, planningRequestId: req1,
    ownerId: "worker-c", now: new Date().toISOString(), leaseDurationMs: 60000,
    workerAttemptId: `${prefix}-attempt-c`, workerId: "worker-c", modelConfigurationId: "cfg-1",
    attemptKind: "initial_invocation", attemptNumber: 1, contextHash: "ctxhash1", correlationId: "corr-3", causationId: null,
  });
  if (!reclaim.ok) { console.error("ABORT: reclaim failed"); process.exit(1); }
  const attemptId = reclaim.attempt.workerAttemptId;
  const fence = reclaim.lease.fencingToken;

  const loaded = await attemptStore.get(attemptId);
  record("adapter-attempt", "get() reads back the claim-created attempt", loaded?.workerAttemptId === attemptId, JSON.stringify(loaded));

  const transitioned = await attemptStore.transition({ workspaceId: wsId, workerAttemptId: attemptId, fencingToken: fence, toState: "invoking", now: new Date().toISOString() });
  record("adapter-attempt", "legal transition via adapter", transitioned.ok === true, JSON.stringify(transitioned));

  const attach = await attemptStore.attachProviderRequestId({ workspaceId: wsId, workerAttemptId: attemptId, fencingToken: fence, providerRequestId: "prov-req-adapter-1" });
  record("adapter-attempt", "provider execution ID attachment via adapter", attach.ok === true, JSON.stringify(attach));

  const attachConflict = await attemptStore.attachProviderRequestId({ workspaceId: wsId, workerAttemptId: attemptId, fencingToken: fence, providerRequestId: "prov-req-DIFFERENT" });
  record("adapter-attempt", "provider execution ID is immutable (conflict refused)", attachConflict.ok === false, JSON.stringify(attachConflict));

  const terminal = await attemptStore.transition({ workspaceId: wsId, workerAttemptId: attemptId, fencingToken: fence, toState: "completed", now: new Date().toISOString(), outcomeClassification: "success" });
  record("adapter-attempt", "terminal transition via adapter", terminal.ok === true, JSON.stringify(terminal));

  const terminalAgain = await attemptStore.transition({ workspaceId: wsId, workerAttemptId: attemptId, fencingToken: fence, toState: "failed", now: new Date().toISOString(), outcomeClassification: "provider_rejected" });
  record("adapter-attempt", "terminal attempt not transitioned again", terminalAgain.ok === false && terminalAgain.reason === "conflicting_terminal_write", JSON.stringify(terminalAgain));

  // --- diagnostics adapter round-trip ---
  const stored = await diagStore.store({
    workspaceId: wsId, missionId, planningRequestId: req1, workerAttemptId: attemptId,
    diagnosticKind: "invocation_result", stage: "invocation", modelConfigurationId: "cfg-1",
    providerRequestId: "prov-req-adapter-1", contextHash: "ctxhash1",
    promptMetadataSummary: "1 constraint, 0 snippets", detail: "adapter harness test detail",
    createdAt: new Date().toISOString(),
  });
  record("adapter-diagnostics", "store() round-trips via adapter", !!stored.ref, JSON.stringify(stored));

  const fetched = await diagStore.get(wsId, stored.ref);
  record("adapter-diagnostics", "get() resolves the stored diagnostic", fetched !== null && fetched.detail === "adapter harness test detail", JSON.stringify(fetched));

  const crossWs = await diagStore.get("some-other-workspace", stored.ref);
  record("adapter-diagnostics", "cross-workspace get() returns null via adapter", crossWs === null, JSON.stringify(crossWs));

  // --- cleanup ---
  console.log("\n=== Cleanup ===");
  const { data: toDelete } = await client.from("missions").select("id, workspace_id").eq("id", missionId);
  console.log("rows eligible for deletion (cascade root):", JSON.stringify(toDelete));
  const { error: cleanupErr } = await client.from("missions").delete().eq("id", missionId);
  if (cleanupErr) console.error("CLEANUP FAILED:", cleanupErr.message);
  const { data: verifyGone } = await client.from("missions").select("id").eq("id", missionId);
  console.log(`verify: missions row remaining = ${verifyGone?.length ?? "?"} (expect 0)`);

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
