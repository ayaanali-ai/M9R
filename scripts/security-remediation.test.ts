import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("legacy rule operations derive identity from the cookie session and always owner-scope queries", () => {
  const listRoute = source("src/app/api/rules/route.ts");
  const itemRoute = source("src/app/api/rules/[id]/route.ts");
  const service = source("src/lib/rules-service.ts");
  assert.ok(!/x-user-id/i.test(`${listRoute}\n${itemRoute}`));
  assert.match(service, /async function requireAuthenticatedDb/);
  assert.match(service, /db\.auth\.getUser\(\)/);
  assert.equal((service.match(/\.eq\("created_by", userId\)/g) ?? []).length, 3);
});

test("trace uploads ignore caller identity and verify project ownership before service-role persistence", () => {
  const route = source("src/app/api/traces/upload/route.ts");
  assert.ok(!/x-user-id|parsed\.userId|obj\.userId|form\.get\("userId"\)/i.test(route));
  assert.match(route, /db\.auth\.getUser\(\)/);
  assert.match(route, /\.eq\("owner_id", user\.id\)/);
  assert.match(route, /uploadTrace\(parsed\.trace, user\.id, projectId/);
});

test("diff-review evidence is immutable to generic authenticated updates", () => {
  const migration = source("supabase/migrations/20260729060000_narrow_diff_review_decisions.sql");
  const service = source("src/lib/resident-diff-review-service.ts");
  assert.match(migration, /revoke update on public\.launch_diff_reviews from authenticated/i);
  assert.match(migration, /drop policy if exists "owners decide launch diff reviews"/i);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(migration, /review\.decision = 'pending'/i);
  assert.match(migration, /project\.owner_id = v_actor/i);
  assert.match(service, /\.rpc\("decide_launch_diff_review"/);
  assert.ok(!/\.from\("launch_diff_reviews"\)\.update/.test(service));

  const anonRevokeMigration = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/20260729061000_revoke_anon_diff_review_rpc.sql",
    ),
    "utf8",
  );
  assert.match(
    anonRevokeMigration,
    /revoke execute on function public\.decide_launch_diff_review\(uuid,\s*text,\s*timestamptz\) from anon/i,
  );
});

test("local agent-state mutation exists only on the authorized terminal socket", () => {
  const bridge = source("scripts/oathlock-terminal-bridge.ts");
  const cli = source("scripts/m9r-cli.ts");
  assert.ok(!/POST" && request\.url === "\/agent-state"/.test(bridge));
  assert.match(bridge, /sessions\.requireProvider\(message\.sessionId, connectionProvider\)/);
  assert.match(bridge, /type: "state-recorded"/);
  assert.match(cli, /new WebSocket/);
  assert.ok(!/fetch\("http:\/\/127\.0\.0\.1:43117\/agent-state"/.test(cli));
});

test("local browser audit artifacts are ignored and no longer tracked", () => {
  const gitignore = source(".gitignore");
  assert.match(gitignore, /^\.gstack\/$/m);
});
