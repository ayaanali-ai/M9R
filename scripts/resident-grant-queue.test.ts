import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { launchGrantIdempotencyKey } from "@/lib/resident-grant-service";

test("launch grant idempotency is derived only from the retained assignment", () => {
  assert.equal(launchGrantIdempotencyKey("assignment-12345678"), "assignment:assignment-12345678:launch:v1");
  assert.throws(() => launchGrantIdempotencyKey("short"), /assignment id/i);
});

test("routing queues an atomic launch grant after assignment creation on both approval paths", async () => {
  const routing = await readFile(new URL("../src/lib/resident-routing-service.ts", import.meta.url), "utf8");
  assert.match(routing, /queueLaunchGrant/);
  assert.ok((routing.match(/await queueLaunchGrant\(/g) ?? []).length >= 2);
  assert.match(routing, /launch_grant_id/);
});

test("launch-grant queue failures retain a safe reason for the operator instead of collapsing to a generic 500", async () => {
  const grantService = await readFile(new URL("../src/lib/resident-grant-service.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../src/app/api/assignments/routing/[id]/route.ts", import.meta.url), "utf8");
  assert.match(grantService, /LAUNCH_GRANT_QUEUE_FAILED/);
  assert.match(grantService, /error\?\.code/);
  assert.match(route, /error\.message/);
});

test("launch grant queue service uses the server-only atomic RPC and retains no raw claim token", async () => {
  const service = await readFile(new URL("../src/lib/resident-grant-service.ts", import.meta.url), "utf8");
  assert.match(service, /create_resident_launch_grant_v2_atomic/);
  assert.match(service, /p_model_tier/);
  assert.doesNotMatch(service, /rawClaimToken|claimToken\s*:/);
  assert.match(service, /createHash\("sha256"\)/);
});

test("migration atomically validates authorization, creates custody events, and links the assignment", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713210000_gate11a_resident_launch.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.create_resident_launch_grant_atomic/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /resident_provider_authorizations/i);
  assert.match(sql, /insert into public\.launch_events/i);
  assert.match(sql, /'authorize'/i);
  assert.match(sql, /'queue'/i);
  assert.match(sql, /update public\.agent_assignments[\s\S]*launch_grant_id/i);
  assert.match(sql, /revoke all on function public\.create_resident_launch_grant_atomic/i);
  assert.match(sql, /grant execute on function public\.create_resident_launch_grant_atomic[^\n]+service_role/i);
});

test("corrective grant RPC matches the routed assignment target connection column", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713231542_gate11e_fix_launch_grant_target.sql", import.meta.url), "utf8");
  assert.match(sql, /aa\.target_connection_id\s*=\s*p_target_connection_id/i);
  assert.doesNotMatch(sql, /aa\.connection_id\s*=\s*p_target_connection_id/i);
  assert.match(sql, /revoke all on function public\.create_resident_launch_grant_atomic/i);
  assert.match(sql, /grant execute on function public\.create_resident_launch_grant_atomic[^\n]+service_role/i);
});
