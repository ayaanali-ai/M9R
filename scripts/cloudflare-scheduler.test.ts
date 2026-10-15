import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CRON_JOBS, jobForCron, runCronJob, schedulerEnabled, type Env } from "../services/cron-scheduler/src/index.ts";

const env: Env = {
  TARGET_BASE_URL: "https://m9r.dev/",
  CRON_SECRET: "test-secret",
};

test("the scheduler config retains all four sweep cadences", () => {
  const config = JSON.parse(readFileSync(resolve("services/cron-scheduler/wrangler.jsonc"), "utf8")) as { triggers?: { crons?: string[] }; vars?: { SCHEDULER_ENABLED?: string } };
  assert.deepEqual(config.triggers?.crons, Object.keys(CRON_JOBS));
  assert.equal(config.vars?.SCHEDULER_ENABLED, "true");
});

test("the scheduler gate is explicit and can be paused", () => {
  assert.equal(schedulerEnabled({ SCHEDULER_ENABLED: "false" }), false);
  assert.equal(schedulerEnabled({ SCHEDULER_ENABLED: "true" }), true);
  assert.equal(schedulerEnabled({}), false);
});

test("every configured cron maps to a fixed internal route", () => {
  assert.deepEqual(Object.values(CRON_JOBS).map((job) => job.path), [
    "/api/internal/work-signal-sweep",
    "/api/internal/stale-run-sweep",
    "/api/internal/workflow-scheduler",
    "/api/internal/idle-session-sweep",
  ]);
  assert.throws(() => jobForCron("0 0 * * *"), /No scheduler job/);
  assert.throws(() => jobForCron("__proto__"), /No scheduler job/);
});

test("a scheduled sweep sends only the fixed path and bearer secret", async () => {
  let request: Request | undefined;
  const result = await runCronJob("0 3 * * *", env, async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.deepEqual(result, { name: "work-signal-sweep", path: "/api/internal/work-signal-sweep", status: 200 });
  assert.equal(request?.method, "GET");
  assert.equal(request?.url, "https://m9r.dev/api/internal/work-signal-sweep");
  assert.equal(request?.headers.get("authorization"), "Bearer test-secret");
});

test("the scheduler fails closed for invalid targets, missing secrets, and non-2xx responses", async () => {
  await assert.rejects(() => runCronJob("15 3 * * *", { ...env, TARGET_BASE_URL: "http://example.test" }), /TARGET_BASE_URL/);
  await assert.rejects(() => runCronJob("15 3 * * *", { ...env, CRON_SECRET: " " }), /CRON_SECRET/);
  await assert.rejects(() => runCronJob("15 3 * * *", env, async () => new Response(null, { status: 503 })), /HTTP 503/);
});
