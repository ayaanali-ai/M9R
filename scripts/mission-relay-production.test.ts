import assert from "node:assert/strict";
import test from "node:test";
import { createProductionMissionRelayOptions } from "@/lib/mission/mission-relay-production";
import { mintMissionRelayToken } from "@/lib/mission/mission-relay-token";

test("production Relay authentication accepts workspace-scoped signed Bridge credentials", async () => {
  const secret = "relay-secret-012345678901234567890123";
  const options = createProductionMissionRelayOptions({ tokenSecret: secret });
  const token = mintMissionRelayToken({ subject: "bridge-1", kind: "bridge", workspaceId: "workspace-1", ttlSeconds: 60 }, secret);
  await assert.doesNotReject(options.authenticator.authenticate({ kind: "bridge", credential: token, workspaceId: "workspace-1" }));
  await assert.rejects(options.authenticator.authenticate({ kind: "bridge", credential: token, workspaceId: "workspace-2" }), /invalid or expired/);
});
