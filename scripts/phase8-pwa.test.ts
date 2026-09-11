import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parsePushSubscription } from "../src/lib/push-subscription";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

test("Phase 8 ships an installable manifest with a truthful Watchfloor entry point", async () => {
  const manifest = await read("src/app/manifest.ts");
  assert.match(manifest, /start_url:\s*"\/dashboard\/agents"/);
  assert.match(manifest, /display:\s*"standalone"/);
  assert.match(manifest, /oathlock-logo-transparent\.png/);
});

test("Phase 8 service worker has offline fallback and safe notification clicks", async () => {
  const worker = await read("public/sw.js");
  assert.match(worker, /caches\.open\(CACHE_NAME\)/);
  assert.match(worker, /fetch\(event\.request\)\.catch\(\(\) => caches\.match\(OFFLINE_URL\)\)/);
  assert.match(worker, /data\.url.*startsWith\("\/"\)/);
  assert.match(worker, /showNotification/);
});

test("Phase 8 keeps service-worker delivery secure and uncached", async () => {
  const config = await read("next.config.ts");
  assert.match(config, /source: "\/sw\.js"/);
  assert.match(config, /no-cache, no-store, must-revalidate/);
  assert.match(config, /default-src 'self'; script-src 'self'/);
});

test("Phase 8 has a durable subscription boundary instead of browser-only state", async () => {
  const route = await read("src/app/api/notifications/push/route.ts");
  const migration = await read("supabase/migrations/20260815220907_push_subscriptions.sql");
  assert.match(route, /requireHuman: true/);
  assert.match(route, /push_subscriptions/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on public\.push_subscriptions from anon, authenticated/i);
});

test("push subscription parsing rejects non-HTTPS and malformed browser payloads", () => {
  const valid = {
    endpoint: "https://push.example.test/send/opaque-id",
    keys: { p256dh: "p256dh-value_1", auth: "auth-value_1" },
  };
  assert.deepEqual(parsePushSubscription(valid), {
    endpoint: valid.endpoint,
    p256dh: valid.keys.p256dh,
    auth: valid.keys.auth,
  });
  assert.equal(parsePushSubscription({ ...valid, endpoint: "http://push.example.test/send/opaque-id" }), null);
  assert.equal(parsePushSubscription({ ...valid, keys: { p256dh: "not valid", auth: "ok" } }), null);
});
