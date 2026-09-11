import assert from "node:assert/strict";
import test from "node:test";
import { mintMissionRelayToken, verifyMissionRelayToken } from "@/lib/mission/mission-relay-token";

const secret = "test-secret-that-is-long-enough-for-hmac-signing-123456";

test("Mission Relay tokens round-trip with bounded workspace claims", () => {
  const token = mintMissionRelayToken({
    subject: "human-1",
    kind: "human",
    workspaceId: "workspace-1",
    nowSeconds: 1_700_000_000,
    ttlSeconds: 300,
  }, secret);
  assert.deepEqual(verifyMissionRelayToken(token, secret, 1_700_000_100), {
    subject: "human-1",
    kind: "human",
    workspaceId: "workspace-1",
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_300,
  });
});

test("Mission Relay tokens fail closed on tampering, expiry, and wrong signing secret", () => {
  const token = mintMissionRelayToken({ subject: "bridge-1", kind: "bridge", workspaceId: "workspace-1", nowSeconds: 1_700_000_000, ttlSeconds: 60 }, secret);
  assert.equal(verifyMissionRelayToken(`${token}tampered`, secret, 1_700_000_001), null);
  assert.equal(verifyMissionRelayToken(token, secret, 1_700_000_061), null);
  assert.equal(verifyMissionRelayToken(token, `${secret}-wrong`, 1_700_000_001), null);
});

test("Mission Relay refuses short signing secrets", () => {
  assert.throws(() => mintMissionRelayToken({ subject: "human-1", kind: "human", workspaceId: "workspace-1" }, "short"), /secret/);
});
