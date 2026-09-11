import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Rules used to reach an agent only if it independently ran `npx oathlock
 * rules` mid-conversation -- easy to skip, unlike MANDATORY_REPORT_INSTRUCTION
 * which is baked directly into every prompt. This locks in the real fetch +
 * delivery wiring: Claude Code gets active rules once at session creation via
 * ACP's _meta.systemPrompt (confirmed real in the installed
 * @agentclientprotocol/claude-agent-acp package, not assumed); Codex/OpenCode,
 * whose ACP wrappers expose no equivalent, fall back to per-turn injection.
 */

test("the bridge fetches active rules from the real GET /api/agent/rules endpoint, best-effort", () => {
  const source = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");
  assert.match(source, /async function refreshOwnActiveRules\(\): Promise<void>/);
  assert.match(source, /fetch\(`\$\{appUrl\}\/api\/agent\/rules`/);
  assert.match(source, /body\.mode !== "active"/);
  assert.match(source, /await refreshOwnActiveRules\(\);/);
});

test("startSession threads the fetched rules text into the provider assignment", () => {
  const source = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");
  assert.match(source, /activeRulesText: ownActiveRulesText,/);
});

test("Claude Code sessions get active rules once via ACP's _meta.systemPrompt at session creation, not re-sent every turn", () => {
  const source = readFileSync("src/lib/bridge/acp-stdio-adapter.ts", "utf8");
  assert.match(source, /input\.server\.adapterId === "claude-agent-acp"/);
  // Item #16 Part A: rules and persona are combined into one append, rules
  // first so they win any conflict -- see systemPromptAppend below.
  assert.match(source, /const systemPromptAppend = \[rulesText, personaText\]\.filter\(Boolean\)\.join\("\\n\\n"\) \|\| null;/);
  assert.match(source, /\{ systemPrompt: \{ append: systemPromptAppend \} \}/);
  assert.match(source, /_meta: meta/);
});

test("Codex/OpenCode fall back to per-turn injection, and Claude Code is explicitly skipped there to avoid resending what it already got once", () => {
  const source = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");
  assert.match(source, /session\?\.providerAdapterId === "claude-agent-acp" \? null : ownActiveRulesText/);
});

test("item #16 Part A: persona text is fetched from the real GET /api/agent/persona endpoint and threaded the same way as rules", () => {
  const source = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");
  assert.match(source, /async function refreshOwnPersonaText\(\): Promise<void>/);
  assert.match(source, /fetch\(`\$\{appUrl\}\/api\/agent\/persona`/);
  assert.match(source, /await refreshOwnPersonaText\(\);/);
  assert.match(source, /personaText: ownPersonaText,/);
  assert.match(source, /session\?\.providerAdapterId === "claude-agent-acp" \? null : ownPersonaText/);
});
