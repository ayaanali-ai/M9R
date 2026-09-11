import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("heartbeat storm ordering is serialized in one database transaction", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713043000_gate9_atomic_heartbeat.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/agent-presence-service.ts", import.meta.url), "utf8");
  assert.match(sql, /for update/i);
  assert.match(sql, /max\(l\.sequence\)/i);
  assert.match(sql, /p_sequence <= v_previous_sequence/i);
  assert.match(sql, /revoke all on function public\.record_agent_heartbeat_atomic/i);
  assert.match(sql, /grant execute on function public\.record_agent_heartbeat_atomic[\s\S]+service_role/i);
  assert.match(service, /\.rpc\("record_agent_heartbeat_atomic"/);
  assert.doesNotMatch(service, /\.select\("sequence"\)/);
});

test("assignment, evidence, and run completion are bound to one authenticated workspace and connection", async () => {
  const service = await readFile(new URL("../src/lib/assignment-service.ts", import.meta.url), "utf8");
  const transition = service.slice(service.indexOf("export async function transitionAssignmentForAgent"));
  assert.match(transition, /\.eq\("workspace_id", agent\.workspaceId\)/);
  assert.match(transition, /\.eq\("target_connection_id", agent\.connectionId\)/);
  assert.match(transition, /from\("evidence_records"\)[\s\S]+\.eq\("workspace_id", agent\.workspaceId\)/);
  assert.match(transition, /from\("agent_runs"\)[\s\S]+\.eq\("connection_id", agent\.connectionId\)/);
  assert.match(transition, /\.eq\("state", current\.state\)/);
});

test("public clients cannot execute the atomic heartbeat function", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713043000_gate9_atomic_heartbeat.sql", import.meta.url), "utf8");
  assert.match(sql, /revoke all[\s\S]+from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]+to authenticated/i);
});
