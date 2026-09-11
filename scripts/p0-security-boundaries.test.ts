import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function functionBlock(source: string, name: string, nextMarker: string): string {
  const start = source.indexOf(name);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must end before ${nextMarker}`);
  return source.slice(start, end);
}

test("bearer run start enforces the same server-side preflight gate before creating a run", () => {
  const route = read("src/app/api/agent/run/start/route.ts");
  const bearer = functionBlock(route, "async function bearerRunStart", "export async function POST");

  assert.match(route, /listActiveRulesForAgent/);
  assert.match(bearer, /taskFromBody\(body\)/);
  assert.match(bearer, /parsePathHints\(body\.path_hints\)/);
  assert.match(bearer, /listActiveRulesForAgent\(agent\)/);
  assert.match(bearer, /buildPreflightDecision/);
  assert.match(bearer, /decision\.status === "blocked"/);
  assert.match(bearer, /decision\.status === "needs_approval"/);
  assert.match(bearer, /Human approval is required before starting this run\./);
  assert.doesNotMatch(
    bearer,
    /body\.approved_by_human\s*===\s*true/,
    "a bearer caller cannot establish human approval with its own request body",
  );

  const preflightIndex = bearer.indexOf("buildPreflightDecision");
  const blockedIndex = bearer.indexOf('decision.status === "blocked"');
  const approvalIndex = bearer.indexOf('decision.status === "needs_approval"');
  const startIndex = bearer.indexOf("startAgentRun(");
  assert.ok(preflightIndex >= 0 && preflightIndex < blockedIndex);
  assert.ok(blockedIndex < startIndex, "blocked bearer runs must be rejected before run creation");
  assert.ok(approvalIndex < startIndex, "approval-required bearer runs must be rejected before run creation");
  assert.match(bearer, /preflight/);
});

test("claim approval is a single database transaction guarded by a row lock", () => {
  const service = read("src/lib/agent-join-service.ts");
  const migration = read("supabase/migrations/20260721010000_atomic_agent_claim_lifecycle.sql");
  const approve = functionBlock(service, "export async function approveClaim", "/** Reject a claim");

  assert.match(approve, /\.rpc\("approve_agent_claim_atomic"/);
  assert.doesNotMatch(approve, /\.from\("agent_connections"\)\s*\.insert/);
  assert.doesNotMatch(approve, /\.from\("agent_tokens"\)\s*\.insert/);
  assert.match(migration, /create or replace function public\.approve_agent_claim_atomic/i);
  assert.match(migration, /from public\.agent_claims[\s\S]*for update/i);
  assert.match(migration, /insert into public\.agent_connections/i);
  assert.match(migration, /insert into public\.agent_tokens/i);
  assert.match(migration, /update public\.agent_claims[\s\S]*status = 'approved'/i);
  assert.match(migration, /where claim_id is not null/i);
});

test("one-time claim token retrieval is atomically consumed before it is returned", () => {
  const service = read("src/lib/agent-join-service.ts");
  const migration = read("supabase/migrations/20260721010000_atomic_agent_claim_lifecycle.sql");
  const poll = functionBlock(service, "export async function pollClaimStatus", "// Token authentication");

  assert.match(poll, /\.rpc\("consume_agent_claim_token_atomic"/);
  assert.doesNotMatch(poll, /\.select\([^\n]*one_time_token/);
  assert.doesNotMatch(poll, /\.update\(\{\s*one_time_token:\s*null/);
  assert.match(migration, /create or replace function public\.consume_agent_claim_token_atomic/i);
  assert.match(migration, /from public\.agent_claims[\s\S]*for update/i);
  assert.match(migration, /setup_code_hash\s*<>\s*p_setup_code_hash/i);
  assert.match(migration, /one_time_token = null[\s\S]*token_retrieved_at = p_retrieved_at/i);
  assert.match(migration, /return query select true, null::text, 'approved'::text, token_to_deliver/i);
  assert.match(migration, /revoke all on function public\.consume_agent_claim_token_atomic[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.consume_agent_claim_token_atomic[\s\S]*to service_role/i);
});
