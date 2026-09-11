import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProviderAdapterConfig,
  providerAdapterId,
  providerLabel,
  providerMention,
} from "@/lib/provider-adapter-config";

test("arbitrary provider slugs resolve to stable labels, mentions, and adapter ids", () => {
  assert.equal(providerLabel("gemini-cli"), "Gemini CLI");
  assert.equal(providerMention("gemini-cli-acp"), "gemini-cli");
  assert.equal(providerAdapterId("gemini-cli"), "gemini-cli-acp");
  assert.equal(providerAdapterId("claude-code"), "claude-agent-acp");
});

test("generic ACP adapter configuration is bounded and preserves argv", () => {
  const parsed = parseProviderAdapterConfig({ command: "gemini", args: ["acp", "--stdio"], label: "Gemini CLI" }, "gemini-cli");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.args, ["acp", "--stdio"]);
    assert.equal(parsed.value.protocol, "acp-stdio");
  }
});

test("generic ACP adapter configuration rejects malformed slugs and shell metacharacters", () => {
  assert.equal(parseProviderAdapterConfig({ command: "gemini" }, "Gemini Prime").ok, false);
  assert.equal(parseProviderAdapterConfig({ command: "gemini; whoami", shell: true }, "gemini-cli").ok, false);
  assert.equal(parseProviderAdapterConfig({ command: "gemini", args: ["acp && whoami"], shell: true }, "gemini-cli").ok, false);
  assert.equal(parseProviderAdapterConfig({ command: "gemini", args: ["\u0000"] }, "gemini-cli").ok, false);
});
