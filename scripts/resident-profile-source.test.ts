import assert from "node:assert/strict";
import test from "node:test";

import { applyResidentCredential, refreshResidentProfile, residentCredentialPaths } from "@/lib/resident-profile-source";

test("resident credentials prefer the provider-specific OathLock connection", () => {
  const paths = residentCredentialPaths("C:\\repo", "claude-code");
  assert.match(paths[0].replace(/\\/g, "/"), /\.oathlock\/agents\/claude-code\/local\.json$/);
  assert.match(paths[1].replace(/\\/g, "/"), /\.oathlock\/local\.json$/);
});

test("current connection credential overrides a stale copied resident token", () => {
  const profile = applyResidentCredential({ provider: "codex", token: "stale-token-value" }, { token: "current-token-value-that-is-long-enough" });
  assert.equal(profile.token, "current-token-value-that-is-long-enough");
  assert.throws(() => applyResidentCredential({ provider: "codex" }, { token: "short" }), /reconnect/i);
});

test("refresh preserves bounded policy but replaces connection-bound identity and copied token", () => {
  const refreshed = refreshResidentProfile({
    name: "claude", provider: "claude-code", token: "stale-secret",
    instanceKey: "claude-old-instance", repositoryBindingId: "binding-123",
    capabilities: ["review"], heartbeatSequence: 9,
  }, "new-instance-id");
  assert.equal(refreshed.instanceKey, "new-instance-id");
  assert.equal(refreshed.heartbeatSequence, 0);
  assert.equal(refreshed.repositoryBindingId, "binding-123");
  assert.deepEqual(refreshed.capabilities, ["review"]);
  assert.equal("token" in refreshed, false);
});
