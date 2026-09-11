import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { acceptWorkSignal } from "@/lib/work-signal";

const base = { protocolVersion: "oathlock.work-signal.v1", adapterInstanceId: "adapter-12345678", clientSequence: 2, idempotencyKey: "signal-1234567890", type: "WORKING", source: "observed", summary: "Editing scoped files", scope: ["src/lib/a.ts"], repo: "github.com/tysonali989/runleak" };

test("accepts a bounded observed signal without client ownership fields", () => {
  const result = acceptWorkSignal(base, { previousSequence: 1, receivedAt: "2026-07-12T12:00:00Z" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.signal.receivedAt, "2026-07-12T12:00:00.000Z");
    assert.equal(result.signal.repo, base.repo);
    assert.equal(result.signal.correlationId, null);
  }
});

test("accepts optional correlation and parent-event identifiers", () => {
  const result = acceptWorkSignal({ ...base, correlationId: "corr-1", parentEventId: "evt-0" }, { previousSequence: null, receivedAt: "2026-07-12T12:00:00Z" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.signal.correlationId, "corr-1");
    assert.equal(result.signal.parentEventId, "evt-0");
  }
});

test("rejects replay, unsupported source, unsafe unbounded text, and missing repo", () => {
  assert.equal(acceptWorkSignal(base, { previousSequence: 2, receivedAt: "2026-07-12T12:00:00Z" }).ok, false);
  assert.equal(acceptWorkSignal({ ...base, source: "verified" }, { previousSequence: null, receivedAt: "2026-07-12T12:00:00Z" }).ok, false);
  assert.equal(acceptWorkSignal({ ...base, summary: "x".repeat(201) }, { previousSequence: null, receivedAt: "2026-07-12T12:00:00Z" }).ok, false);
  assert.equal(acceptWorkSignal({ ...base, repo: undefined }, { previousSequence: null, receivedAt: "2026-07-12T12:00:00Z" }).ok, false);
  assert.equal(acceptWorkSignal({ ...base, correlationId: "x".repeat(129) }, { previousSequence: null, receivedAt: "2026-07-12T12:00:00Z" }).ok, false);
});

test("Gate 2 schema provides durable ordering, replay protection, RLS, and transactional outbox", async () => {
  const sql = await readFile(new URL("../supabase-work-signals.sql", import.meta.url), "utf8");
  assert.match(sql, /server_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE/i);
  assert.match(sql, /UNIQUE \(connection_id, adapter_instance_id, client_sequence\)/i);
  assert.match(sql, /work_signal_outbox/i);
  assert.match(sql, /CREATE TRIGGER enqueue_work_signal/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON public\.work_signals FROM anon/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS repo TEXT/i);
  assert.match(sql, /ALTER COLUMN repo SET NOT NULL/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS correlation_id TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS parent_event_id TEXT/i);
});

test("ingestion service enforces a repository scope check and a coordination budget before insert", async () => {
  const service = await readFile(new URL("../src/lib/work-signal-service.ts", import.meta.url), "utf8");
  assert.match(service, /COORDINATION_BUDGET_LIMIT/);
  assert.match(service, /BUDGET_EXCEEDED/);
  assert.match(service, /repoInScope/);
  assert.match(service, /REPO_OUT_OF_SCOPE/);
});

test("ingestion route derives connection and workspace from bearer authentication", async () => {
  const route = await readFile(new URL("../src/app/api/agent/signals/route.ts", import.meta.url), "utf8");
  assert.match(route, /authenticateAgent\(bearerFrom/);
  assert.doesNotMatch(route, /body\.workspace|body\.connection/);
});
