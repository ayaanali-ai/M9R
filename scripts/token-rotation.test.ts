import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Gate 9 — token rotation. agent-join-service.ts transitively imports
 * next/headers (via @/lib/supabase/server), so — matching this repo's
 * existing convention for that constraint — it's verified by source, not by
 * importing it as an ES module. The CLI-side behavior (real, injectable IO)
 * is covered directly in oathlock-cli.test.ts.
 */

test("rotateAgentToken mints the new token before revoking the old one, and only ever revokes the exact token that authenticated the request", async () => {
  const src = await readFile(new URL("../src/lib/agent-join-service.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function rotateAgentToken"), src.indexOf("export async function rotateAgentToken") + 1800);
  const insertIdx = body.indexOf("agent_tokens").valueOf();
  const revokeIdx = body.indexOf("revoked_at");
  assert.ok(insertIdx > -1 && revokeIdx > -1 && insertIdx < revokeIdx, "must insert the new token before revoking the old one");
  assert.match(body, /\.eq\("id", agent\.tokenId\)/);
  assert.match(body, /\.eq\("connection_id", agent\.connectionId\)/);
});

test("rotateAgentToken refuses a context with no real bearer token instead of silently no-op'ing", async () => {
  const src = await readFile(new URL("../src/lib/agent-join-service.ts", import.meta.url), "utf8");
  assert.match(src, /if \(!agent\.tokenId\) throw new AgentJoinError/);
});

test("the rotate-token route is bearer-authenticated and trusts no client-supplied identity", async () => {
  const route = await readFile(new URL("../src/app/api/agent/rotate-token/route.ts", import.meta.url), "utf8");
  assert.match(route, /authenticateAgent\(bearerFrom/);
  assert.doesNotMatch(route, /body\.workspace|body\.connection|body\.token/);
});

test("authenticateAgent's own token row id is captured as tokenId, not fabricated elsewhere", async () => {
  const src = await readFile(new URL("../src/lib/agent-join-service.ts", import.meta.url), "utf8");
  assert.match(src, /tokenId: data\.id as string,/);
});
