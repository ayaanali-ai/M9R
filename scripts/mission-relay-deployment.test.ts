import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Render Blueprint defines a free, health-checked Mission Relay service without committed secrets", () => {
  const blueprint = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
  assert.match(blueprint, /type: web/);
  assert.match(blueprint, /runtime: node/);
  assert.match(blueprint, /plan: free/);
  assert.match(blueprint, /startCommand: npm run relay:start/);
  assert.match(blueprint, /healthCheckPath: \/healthz/);
  assert.doesNotMatch(blueprint, /SUPABASE_SERVICE_ROLE_KEY\s*:\s*[^\s]/);
  assert.match(blueprint, /sync: false/);
});
