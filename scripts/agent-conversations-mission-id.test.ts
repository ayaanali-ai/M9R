/**
 * Regression: listOpenConversationsForAgent (backs GET /api/agent/conversations,
 * which scanWorkspaceMessages -- services/mission-bridge/src/bridge-runtime.ts --
 * polls to decide whether an @mention can spawn a dynamic ACP session at all)
 * used to select id/workspace_id/topic/status/created_at only, never
 * mission_id. ensureDynamicSessionForConversation requires a truthy
 * mission_id before it will even attempt to start a session, so every
 * mention in a real, mission-bound channel silently did nothing -- not an
 * error, just a check that could never pass. Found live, testing the actual
 * mention flow end to end, not from reading the code.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

test("listOpenConversationsForAgent selects mission_id from agent_conversations", () => {
  const src = read("src/lib/conversation-service.ts");
  const fn = src.slice(src.indexOf("export async function listOpenConversationsForAgent"), src.indexOf("export interface SpawnedHandoffRun"));
  const selectCall = fn.match(/\.from\("agent_conversations"\)\s*\.select\("([^"]+)"\)/);
  assert.ok(selectCall, "expected a .from(\"agent_conversations\").select(...) call in listOpenConversationsForAgent");
  assert.match(selectCall![1], /\bmission_id\b/, "the select column list must include mission_id, or the bridge's mention-triggered dynamic session check can never pass");
});

test("listOpenConversationsForAgent's returned summary carries mission_id through, not just the raw row", () => {
  const src = read("src/lib/conversation-service.ts");
  const fn = src.slice(src.indexOf("export async function listOpenConversationsForAgent"), src.indexOf("export interface SpawnedHandoffRun"));
  assert.match(fn, /mission_id:\s*\(conversation as \{[^}]*mission_id/, "the mapped return object must forward mission_id, not drop it after selecting it");
});

test("ConversationSummary's type declares mission_id, so a future refactor gets a compile error if it's dropped again", () => {
  const src = read("src/lib/conversation-service.ts");
  const iface = src.slice(src.indexOf("export interface ConversationSummary"), src.indexOf("export interface ConversationSummary") + 600);
  assert.match(iface, /mission_id\?:\s*string \| null/);
});
