import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("rule effectiveness has an explicit persistence boundary", () => {
  const source = readFileSync("src/lib/workspace-rules-service.ts", "utf8");
  assert.match(source, /export async function applyRuleEffectivenessDecision/);
  assert.match(source, /decision\.action === "increment_helped"/);
  assert.match(source, /decision\.action === "mark_needs_review"/);
  assert.match(source, /await markRuleNeedsReview\(decision\.ruleId\)/);
});

test("effectiveness persistence cannot auto-promote a rule", () => {
  const source = readFileSync("src/lib/workspace-rules-service.ts", "utf8");
  const start = source.indexOf("export async function applyRuleEffectivenessDecision");
  const end = source.indexOf("/** Rewrite a rule's title", start);
  assert.ok(!/promoteWorkspaceRule\(/.test(source.slice(start, end)));
});
