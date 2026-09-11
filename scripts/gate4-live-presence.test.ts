import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Gate 4 — Live Agent Floor, first increment: the dashboard's live run list
 * must be driven by the real Gate 1 presence model (deriveAgentPresence),
 * not a second, ad-hoc status→tone mapping invented at the UI layer. These
 * modules transitively import next/headers (via @/lib/supabase/server), so —
 * matching this repo's existing convention for that constraint — they are
 * verified by reading the source, not by importing them as ES modules.
 */

test("listAgentRunsForUser attaches real presence derived from deriveAgentPresence, not a re-implementation", async () => {
  const src = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  assert.match(src, /import\s*\{\s*deriveAgentPresence,\s*type AgentPresence\s*\}\s*from\s*"@\/lib\/agent-presence"/);
  assert.match(src, /async function attachPresence/);
  assert.match(src, /deriveAgentPresence\(\{/);
  assert.match(src, /return attachPresence\(cookieDb, runs\);/);
});

test("attachPresence never fabricates presence from a failed connection lookup", async () => {
  const src = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function attachPresence"), src.indexOf("async function attachPresence") + 1800);
  assert.match(body, /if \(error \|\| !data\) return runs;/);
  assert.match(body, /if \(!conn\) return run;/);
});

test("execution_origin is read from the connection's own last accepted heartbeat, never trusted from elsewhere", async () => {
  const src = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  assert.match(src, /conn\.execution_origin === "linked" \|\| conn\.execution_origin === "resident"/);
});

test("LiveRunsPanel renders the server-derived presence label/tone, not a second status→tone mapping", async () => {
  const src = await readFile(new URL("../src/components/product/LiveRunsPanel.tsx", import.meta.url), "utf8");
  assert.match(src, /import type \{ AgentPresenceState \} from "@\/lib\/agent-presence"/);
  assert.match(src, /function presenceTone\(state: AgentPresenceState\)/);
  assert.match(src, /run\.presence\.label/);
  assert.doesNotMatch(src, /function runTone/, "the old ad-hoc status→tone mapping must be removed, not left dead alongside the real one");
  assert.doesNotMatch(src, /STATUS_LABEL/, "the old ad-hoc status label table must be removed");
});

test("LiveRunsPanel shows an execution-origin badge and a last-confirmed timestamp distinct from the raw last-seen time", async () => {
  const src = await readFile(new URL("../src/components/product/LiveRunsPanel.tsx", import.meta.url), "utf8");
  assert.match(src, /function originLabel/);
  assert.match(src, /originLabel\(run\.execution_origin\)/);
  assert.match(src, /run\.presence\?\.lastConfirmedAt/);
  assert.match(src, /last update unconfirmed/);
});

test("every presence state the Gate 1 model can produce has an explicit lozenge tone (no silent fallthrough to a made-up default)", async () => {
  const presence = await readFile(new URL("../src/lib/agent-presence.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/components/product/LiveRunsPanel.tsx", import.meta.url), "utf8");
  const stateMatch = presence.match(/export type AgentPresenceState =\s*([\s\S]*?);/);
  assert.ok(stateMatch, "could not find AgentPresenceState union in agent-presence.ts");
  const states = Array.from(stateMatch![1].matchAll(/"(\w+)"/g)).map((m) => m[1]);
  assert.ok(states.length >= 8, "expected the full Gate 1 state set");
  for (const state of states) {
    assert.match(panel, new RegExp(`case "${state}":`), `LiveRunsPanel's presenceTone is missing an explicit case for "${state}"`);
  }
});
