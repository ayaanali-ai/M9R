import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("V2 run-scoped tables use composite workspace ownership constraints", async () => {
  const [runs, dispatches, responses, findings, evidence] = await Promise.all([
    read("supabase-agent-runs.sql"), read("supabase-dispatches.sql"), read("supabase-responses.sql"),
    read("supabase-findings.sql"), read("supabase-evidence-records.sql"),
  ]);
  assert.match(runs, /UNIQUE\s*\(id, workspace_id\)/i);
  assert.match(dispatches, /FOREIGN KEY\s*\(run_id, workspace_id\)[\s\S]*agent_runs\s*\(id, workspace_id\)/i);
  assert.match(responses, /FOREIGN KEY\s*\(dispatch_id, run_id, workspace_id\)[\s\S]*dispatches\s*\(id, run_id, workspace_id\)/i);
  assert.match(findings, /FOREIGN KEY\s*\(originating_run_id, workspace_id\)[\s\S]*agent_runs\s*\(id, workspace_id\)/i);
  assert.match(evidence, /FOREIGN KEY\s*\(run_id, workspace_id\)[\s\S]*agent_runs\s*\(id, workspace_id\)/i);
});

test("evidence approval is explicit and never defaults true", async () => {
  const sql = await read("supabase-evidence-records.sql");
  assert.doesNotMatch(sql, /human_approved_submission\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+true/i);
  assert.match(sql, /human_approved_submission\s+BOOLEAN\s+NOT NULL\s+CHECK\s*\(human_approved_submission = true\)/i);
});

test("presence schema binds heartbeats to connection workspace and protects sequence replay", async () => {
  const sql = await read("supabase-agent-presence.sql");
  assert.match(sql, /execution_origin[\s\S]*linked[\s\S]*resident/i);
  assert.match(sql, /UNIQUE\s*\(connection_id, adapter_instance_id, sequence\)/i);
  assert.match(sql, /FOREIGN KEY\s*\(connection_id, workspace_id\)[\s\S]*agent_connections\s*\(id, workspace_id\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /GRANT SELECT ON public\.agent_presence_leases TO authenticated/i);
  assert.match(sql, /REVOKE ALL ON public\.agent_presence_leases FROM anon/i);
  assert.match(sql, /REVOKE ALL ON public\.agent_presence_leases FROM authenticated/i);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE).*authenticated/i);
});
