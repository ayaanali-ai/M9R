import assert from "node:assert/strict";
import test from "node:test";

import { deriveAgentPresence, PRESENCE_FRESH_MS, PRESENCE_STALE_MS } from "@/lib/agent-presence";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("a connected agent sleeps until a fresh provider-side event is observed", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", nowMs: NOW }).state, "asleep");
});

test("a fresh authenticated connection event makes an idle agent awake", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", connectionObservedAt: ago(PRESENCE_FRESH_MS - 1), nowMs: NOW }).state, "awake");
});

test("a live run is working only while its run event is fresh", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", run: { status: "working", observedAt: ago(PRESENCE_FRESH_MS - 1) }, nowMs: NOW }).state, "working");
  assert.equal(deriveAgentPresence({ connectionStatus: "active", run: { status: "working", observedAt: ago(PRESENCE_FRESH_MS + 1) }, nowMs: NOW }).state, "stale");
});

test("waiting and evidence presence require persisted run states", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", run: { status: "waiting_for_human", observedAt: ago(1_000) }, nowMs: NOW }).state, "waiting");
  assert.equal(deriveAgentPresence({ connectionStatus: "active", run: { status: "evidence_ready", observedAt: ago(1_000) }, nowMs: NOW }).state, "evidence");
});

test("old activity becomes asleep instead of pretending the provider is online", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", connectionObservedAt: ago(PRESENCE_STALE_MS + 1), nowMs: NOW }).state, "asleep");
});

test("revoked and failed states override activity", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "revoked", connectionObservedAt: ago(1_000), nowMs: NOW }).state, "disconnected");
  assert.equal(deriveAgentPresence({ connectionStatus: "active", run: { status: "failed", observedAt: ago(1_000) }, nowMs: NOW }).state, "error");
});

test("expired runs are stale, not agent failures", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", run: { status: "expired", observedAt: ago(1_000) }, nowMs: NOW }).state, "stale");
});

test("future and invalid timestamps never create live presence", () => {
  assert.equal(deriveAgentPresence({ connectionStatus: "active", connectionObservedAt: "not-a-date", nowMs: NOW }).state, "asleep");
  assert.equal(deriveAgentPresence({ connectionStatus: "active", connectionObservedAt: new Date(NOW + 60_000).toISOString(), nowMs: NOW }).state, "asleep");
});
