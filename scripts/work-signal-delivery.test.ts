import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clampSince, clampLimit, validateAckSequence, isOutboxRowStale, MAX_REPLAY_PAGE, OUTBOX_STALE_MS } from "@/lib/work-signal-delivery-core";

test("clampSince accepts a safe non-negative integer, from string or number, and rejects garbage", () => {
  assert.equal(clampSince(undefined), null);
  assert.equal(clampSince(null), null);
  assert.equal(clampSince(""), null);
  assert.equal(clampSince("42"), 42);
  assert.equal(clampSince(42), 42);
  assert.equal(clampSince(-1), null);
  assert.equal(clampSince("not-a-number"), null);
  assert.equal(clampSince(1.5), null);
});

test("clampLimit defaults and bounds the replay page size", () => {
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit("not-a-number"), 50);
  assert.equal(clampLimit(0), 50);
  assert.equal(clampLimit(10), 10);
  assert.equal(clampLimit(100000), MAX_REPLAY_PAGE);
});

test("validateAckSequence only accepts a safe non-negative integer", () => {
  assert.equal(validateAckSequence(0), 0);
  assert.equal(validateAckSequence(12), 12);
  assert.equal(validateAckSequence(-1), null);
  assert.equal(validateAckSequence(1.5), null);
  assert.equal(validateAckSequence("12"), null);
  assert.equal(validateAckSequence(null), null);
});

test("isOutboxRowStale only fires once the stale window has actually elapsed", () => {
  const now = Date.parse("2026-07-12T12:10:00Z");
  assert.equal(isOutboxRowStale("2026-07-12T12:00:00Z", now, OUTBOX_STALE_MS), true);
  assert.equal(isOutboxRowStale("2026-07-12T12:09:00Z", now, OUTBOX_STALE_MS), false);
  assert.equal(isOutboxRowStale("not-a-date", now, OUTBOX_STALE_MS), false);
});

test("Gate 2B schema adds a per-connection replay cursor and outbox connection scoping", async () => {
  const sql = await readFile(new URL("../supabase-work-signals.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS work_signal_cursors/i);
  assert.match(sql, /last_acked_sequence BIGINT NOT NULL DEFAULT 0/i);
  assert.match(sql, /work_signal_outbox\(delivery_state, available_at\)/i);
  assert.match(sql, /connection_id UUID NOT NULL/);
});

test("replay route requires bearer auth and never trusts a client-asserted connection or workspace id", async () => {
  const route = await readFile(new URL("../src/app/api/agent/signals/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function GET/);
  assert.match(route, /authenticateAgent\(bearerFrom/);
  assert.doesNotMatch(route, /body\.workspace|body\.connection/);
});

test("ack route requires bearer auth and only forwards a client-supplied throughSequence", async () => {
  const route = await readFile(new URL("../src/app/api/agent/signals/ack/route.ts", import.meta.url), "utf8");
  assert.match(route, /authenticateAgent\(bearerFrom/);
  assert.match(route, /acknowledgeSignals\(agent, body\.throughSequence\)/);
});

test("the delivery worker only downgrades unconfirmed rows and is gated on a server-side cron secret, never an agent token", async () => {
  const service = await readFile(new URL("../src/lib/work-signal-delivery.ts", import.meta.url), "utf8");
  const sweepBody = service.slice(service.indexOf("export async function sweepStaleOutbox"));
  assert.match(sweepBody, /delivery_state: "failed"/);
  assert.doesNotMatch(sweepBody, /delivery_state: "delivered"/);

  const route = await readFile(new URL("../src/app/api/internal/work-signal-sweep/route.ts", import.meta.url), "utf8");
  assert.match(route, /CRON_SECRET/);
  assert.doesNotMatch(route, /authenticateAgent/);
});

test("vercel.json schedules the sweep worker at the honest Hobby-compatible daily cadence", async () => {
  const raw = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const config = JSON.parse(raw) as { crons?: Array<{ path?: string; schedule?: string }> };
  assert.ok(config.crons?.some((c) => c.path === "/api/internal/work-signal-sweep" && c.schedule === "0 3 * * *"));
});
