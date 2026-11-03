import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderFailure } from "@/lib/native/provider-health";

test("provider health preserves quota failures as non-retryable evidence", () => {
  const failure = classifyProviderFailure("OpenCode", "Free usage limit reached; try again later");
  assert.deepEqual(failure, {
    kind: "usage-limit",
    retryable: false,
    message: "OpenCode usage-limit: Free usage limit reached; try again later",
  });
});

test("provider health distinguishes model configuration from dead transport", () => {
  assert.equal(classifyProviderFailure("OpenCode", "Model not found: anthropic/claude-sonnet").kind, "model-not-found");
  assert.equal(classifyProviderFailure("OpenCode", "connection refused").kind, "not-running");
  assert.equal(classifyProviderFailure("OpenCode", "request timed out").kind, "timeout");
});
