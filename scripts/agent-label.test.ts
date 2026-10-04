import assert from "node:assert/strict";
import test from "node:test";
import { agentLabelFor } from "../src/lib/agent-label";

test("every agent type gets its own proper name on the messages it sends", () => {
  assert.equal(agentLabelFor("claude-code"), "Claude");
  assert.equal(agentLabelFor("codex"), "Codex");
  assert.equal(agentLabelFor("opencode"), "OpenCode");
  assert.equal(agentLabelFor("antigravity"), "Antigravity");
  assert.equal(agentLabelFor("grok-build"), "Grok Build");
  assert.equal(agentLabelFor("some-new-agent"), "Some New Agent", "an unknown provider is capitalised, never shown as a raw id");
  assert.equal(agentLabelFor(""), "An agent");
});
