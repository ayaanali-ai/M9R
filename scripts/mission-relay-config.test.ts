import assert from "node:assert/strict";
import test from "node:test";
import { readMissionRelayConfig } from "../services/mission-relay/src/config";

const baseEnv = {
  MISSION_RELAY_TOKEN_SECRET: "relay-secret-that-is-long-enough-for-production-123456",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
};

test("Mission Relay config parses bounded host and port", () => {
  assert.deepEqual(readMissionRelayConfig({ ...baseEnv, MISSION_RELAY_HOST: "127.0.0.1", PORT: "8787" }), {
    host: "127.0.0.1",
    port: 8787,
    publicUrl: null,
    tokenSecret: baseEnv.MISSION_RELAY_TOKEN_SECRET,
  });
});

test("Mission Relay config fails closed without production credentials", () => {
  assert.throws(() => readMissionRelayConfig({ ...baseEnv, MISSION_RELAY_TOKEN_SECRET: "short" }), /token secret/);
  assert.throws(() => readMissionRelayConfig({ ...baseEnv, SUPABASE_SERVICE_ROLE_KEY: "" }), /service role/);
  assert.throws(() => readMissionRelayConfig({ ...baseEnv, PORT: "70000" }), /port/);
});
