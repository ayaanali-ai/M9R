import assert from "node:assert/strict";
import test from "node:test";
import {
  BROKER_STARTUP_HEALTH_POLL_MS,
  BROKER_STARTUP_HEALTH_TIMEOUT_MS,
  waitForBrokerHealth,
} from "../src/lib/native/broker-startup-core.ts";

test("broker startup allows a bounded cold-start window and recovers after transient health failures", async () => {
  let time = 0;
  let attempts = 0;
  const waits: number[] = [];
  const result = await waitForBrokerHealth(async () => {
    attempts += 1;
    if (attempts < 4) throw new Error("connection refused while broker starts");
    return true;
  }, {
    now: () => time,
    sleep: async (milliseconds) => { waits.push(milliseconds); time += milliseconds; },
  });

  assert.equal(BROKER_STARTUP_HEALTH_TIMEOUT_MS, 60_000);
  assert.equal(BROKER_STARTUP_HEALTH_POLL_MS, 250);
  assert.deepEqual(result, { ready: true, attempts: 4, elapsedMs: 750 });
  assert.deepEqual(waits, [250, 250, 250]);
});

test("broker startup timeout is bounded and includes a final health check at the deadline", async () => {
  let time = 0;
  let attempts = 0;
  const result = await waitForBrokerHealth(async () => {
    attempts += 1;
    return false;
  }, {
    timeoutMs: 1_000,
    pollIntervalMs: 300,
    now: () => time,
    sleep: async (milliseconds) => { time += milliseconds; },
  });

  assert.deepEqual(result, { ready: false, attempts: 5, elapsedMs: 1_000 });
});
