import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateAvailableModels } from "../src/lib/available-model-options.ts";

/**
 * Model-selector real-list plumbing: ACP's own newSession response already
 * carries a provider's real, live model choices (session config option,
 * category "model") -- the bridge already parsed and validated against it
 * to apply an override, then discarded it. This wires the same data all the
 * way to the dashboard so the model-override control can render a real
 * dropdown instead of a hardcoded, partially-empty catalog or free text.
 */

test("validateAvailableModels accepts a well-formed list and null", () => {
  const list = validateAvailableModels([{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" }]);
  assert.equal(list.ok, true);
  assert.deepEqual(list.ok ? list.normalized : null, [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" }]);

  const cleared = validateAvailableModels(null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.ok ? cleared.normalized : "x", null);
});

test("validateAvailableModels rejects malformed entries and an oversized list, and collapses an empty array to null", () => {
  assert.equal(validateAvailableModels("gpt-5.5").ok, false);
  assert.equal(validateAvailableModels([{ id: "", label: "GPT-5.5" }]).ok, false);
  assert.equal(validateAvailableModels([{ id: "gpt-5.5" }]).ok, false);
  assert.equal(validateAvailableModels(Array.from({ length: 65 }, (_, i) => ({ id: `m${i}`, label: `m${i}` }))).ok, false);
  const empty = validateAvailableModels([]);
  assert.equal(empty.ok, true);
  assert.equal(empty.ok ? empty.normalized : "x", null);
});

test("the ACP adapter discovers a session's real model options from configOptions, not a guessed list", () => {
  const source = readFileSync("src/lib/bridge/acp-stdio-adapter.ts", "utf8");
  assert.match(source, /private discoveredModelOptions\(created: acp\.NewSessionResponse\): \{ id: string; label: string \}\[\] \| null/);
  assert.match(source, /option\.category === "model" && option\.type === "select"/);
  assert.match(source, /this\.registerSession\(state, created\.sessionId, input\.executionId \?\? created\.sessionId, input\.assignment\.missionId, this\.discoveredModelOptions\(created\)\)/);
});

test("the bridge reports discovered models to the app, best-effort, never blocking the session on a failed report", () => {
  const source = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");
  const start = source.indexOf("if (!result.ok) return result;");
  const end = source.indexOf("await relayClient.subscribeMission", start);
  assert.ok(start >= 0 && end > start, "the post-start block must remain explicit");
  const block = source.slice(start, end);
  assert.match(block, /\/api\/agent\/available-models/);
  assert.match(block, /void fetch\(/, "must not block session start on this report");
});

test("the dashboard reads available_models from agent_connections and passes it through to AgentView", () => {
  const pageSource = readFileSync("src/app/dashboard/agents/page.tsx", "utf8");
  assert.match(pageSource, /select\("id, workspace_id, agent_kind, repo_hint, status, created_at, last_seen_at, model, available_models, last_provider_session_ref, created_by"\)/);
  assert.match(pageSource, /available_models: g\.latest\.available_models \?\? null,/);

  const dataSource = readFileSync("src/lib/agent-workspace-data.ts", "utf8");
  assert.match(dataSource, /availableModels: conn\?\.available_models \?\? null,/);
});

test("the model-override control prefers the real discovered list over the hardcoded catalog", () => {
  const source = readFileSync("src/components/product/agent-workspace/strip-board.tsx", "utf8");
  assert.match(source, /agent\.availableModels && agent\.availableModels\.length > 0/);
});
