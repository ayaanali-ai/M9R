import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCapabilities } from "../src/lib/capability-card.ts";
import { buildServiceRecord } from "../src/lib/service-record.ts";

test("valid capabilities normalize, trimmed and deduplicated of whitespace", () => {
  const result = validateCapabilities(["TypeScript implementation", "  Windows verification  "]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.normalized, ["TypeScript implementation", "Windows verification"]);
});

test("rejects a non-array payload", () => {
  const result = validateCapabilities("TypeScript");
  assert.equal(result.ok, false);
});

test("caps the number of capabilities", () => {
  const many = Array.from({ length: 30 }, (_, i) => `capability ${i}`);
  const result = validateCapabilities(many);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.length, 20);
});

test("rejects secret-shaped content in a capability string", () => {
  const result = validateCapabilities(["Bearer sk-live-abcdef1234567890"]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Rejected/.test(e)));
});

test("Service Record never fabricates supporting contributions (Phase 8 not built)", () => {
  const record = buildServiceRecord({
    runsParticipated: 24,
    runsNeedingFollowUp: 3,
    findingsPublished: 5,
    findingsAdopted: 4,
    lastActiveAt: "2026-07-11T10:00:00Z",
  });
  assert.equal(record.supportingContributions, null);
  assert.equal(record.runsParticipated, 24);
  assert.equal(record.findingsAdopted, 4);
});
