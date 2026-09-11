import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("returned results endpoint is bearer authenticated and run scoped", async () => {
  const route = await readFile(new URL("../src/app/api/agent/runs/[id]/results/route.ts", import.meta.url), "utf8");
  assert.match(route, /authenticateAgent/);
  assert.match(route, /listReturnedResultsForAgent/);
  assert.match(route, /listCoordinationStatusesForAgent/);
  assert.match(route, /Invalid or missing agent token/);
});

test("coordination status readout remains requester-scoped and transcript-free", async () => {
  const service = await readFile(new URL("../src/lib/result-adoption-service.ts", import.meta.url), "utf8");
  assert.match(service, /listCoordinationStatusesForAgent/);
  assert.match(service, /requesting_connection_id/);
  assert.match(service, /select\("id, provider, state, updated_at, expires_at"\)/);
  const fnBody = service.match(/export async function listCoordinationStatusesForAgent[\s\S]*?(?=\/\*\*|$)/)?.[0] ?? "";
  // Deriving failure_code requires referencing the launch_events.payload
  // column via Postgrest's ->> operator -- there's no other way to reach one
  // scalar inside it without a schema change. The actual transcript-free
  // guarantee is about what this function HANDS BACK to the requester: the
  // returned contract (and every intermediate value it touches) must carry
  // only the single derived failure_code scalar, never the raw payload
  // object/blob or a result_text/transcript field.
  assert.match(fnBody, /payload->>failure_code/, "failure_code must be derived via a scalar JSON projection, not a full payload fetch");
  assert.doesNotMatch(fnBody, /result_text/);
  assert.doesNotMatch(fnBody, /payload:\s*Record<string,\s*unknown>/, "must never hold the raw payload object in memory");
  const returnBlock = fnBody.match(/return rows\.map[\s\S]*/)?.[0] ?? "";
  assert.doesNotMatch(returnBlock, /\bpayload\b/, "the returned contract must never include a raw payload field");
});

test("route response reports the effective bounded token ceiling", async () => {
  const route = await readFile(new URL("../src/app/api/agent/runs/[id]/request-help/route.ts", import.meta.url), "utf8");
  assert.match(route, /const effectiveTokenCeiling = Math\.min/);
  assert.match(route, /maxEstimatedTokens \?\? Number\.MAX_SAFE_INTEGER/);
  assert.match(route, /max_estimated_tokens: effectiveTokenCeiling/);
});

test("result listing requires requester ownership and only return_result events", async () => {
  const service = await readFile(new URL("../src/lib/result-adoption-service.ts", import.meta.url), "utf8");
  assert.match(service, /requesting_connection_id/);
  assert.match(service, /dispatches[\s\S]+run_id/);
  assert.match(service, /event_type[^\n]+return_result/);
  assert.match(service, /result_adoptions/);
  assert.match(service, /result_text/);
  assert.match(service, /requested_model/);
  assert.match(service, /reported_model/);
});

test("routed coordination retains the latency ceiling used by the value gate", async () => {
  const route = await readFile(new URL("../src/app/api/agent/runs/[id]/request-help/route.ts", import.meta.url), "utf8");
  const routing = await readFile(new URL("../src/lib/resident-routing-service.ts", import.meta.url), "utf8");
  assert.match(route, /maxAddedLatencyMs:\s*maxAddedLatencyMs as number/);
  assert.match(routing, /maxAddedLatencyMs:\s*number/);
  assert.match(routing, /maxAddedLatencyMs:\s*input\.maxAddedLatencyMs/);
});

test("result adoption atomically records the decision and closes the resident lifecycle", async () => {
  const service = await readFile(new URL("../src/lib/result-adoption-service.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20260716233000_gate13_close_result_loop.sql", import.meta.url), "utf8");
  assert.match(service, /record_result_adoption_atomic/);
  assert.match(migration, /insert into public\.result_adoptions/i);
  assert.match(migration, /next_grant_state[\s\S]+completed[\s\S]+evidence_rejected/i);
  assert.match(migration, /update public\.launch_grants set state = next_grant_state/i);
  assert.match(migration, /insert into public\.launch_events/i);
  assert.match(migration, /update public\.agent_assignments/i);
  assert.match(migration, /update public\.dispatches/i);
  assert.match(migration, /revoke all on function public\.record_result_adoption_atomic/i);
  assert.match(migration, /grant execute on function public\.record_result_adoption_atomic[^\n]+service_role/i);
});
