/**
 * Agent session result — web wiring tests
 * ----------------------------------------------------------------------------
 * Proves the session-result surface shows Rule Health only from real data:
 *  - a response WITH rule_health yields a panel-ready object
 *  - a response WITHOUT rule_health yields null (no faked health)
 *  - evaluated:false flows to the honest empty-state copy
 *  - the page source wires RuleHealthPanel to parsed data and carries no
 *    overclaiming language
 *
 * The page is .tsx (JSX isn't transpiled by the node test loader), so the
 * rendering decisions live in the pure parser, tested here, plus a source scan.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseSessionResult,
  parseSessionResultJson,
  extractRuleHealth,
} from "../src/lib/agent-session-result.ts";
import { RULE_HEALTH_EMPTY_COPY } from "../src/lib/rule-health-display.ts";

const PAGE_SRC = readFileSync(
  resolve(process.cwd(), "src/app/report/session/page.tsx"),
  "utf8",
);

const BANNED = [/guarantee/i, /proven success/i, /\bcompliant\b/i, /\bcompliance\b/i, /\bcertified\b/i];

const RESPONSE_WITH_HEALTH = {
  ok: true,
  source_quality: "fair",
  parser_confidence: { confidence: "high" },
  findings_count: 1,
  rules: { recommended: false, message: "no new rules" },
  rule_health: {
    evaluated: true,
    summary: { followed: 0, violated: 1, not_applicable: 0, too_vague: 0, needs_review: 0, obsolete: 0 },
    items: [
      {
        rule_id: "smoke-edit-thrash",
        title: "Inspect root cause before re-editing the same file",
        status: "violated",
        evidenceLevel: "Observed",
        reason: "The edit-thrash pattern recurred in this session even though the rule was loaded.",
        matchedFindingTypes: ["repeated_file_edit"],
      },
    ],
  },
  next_step: "ok",
};

test("a response with rule_health yields a panel-ready, evaluated object", () => {
  const parsed = parseSessionResult(RESPONSE_WITH_HEALTH);
  assert.ok(parsed, "should parse");
  assert.ok(parsed!.ruleHealth, "ruleHealth must be present");
  assert.equal(parsed!.ruleHealth!.evaluated, true);
  assert.equal(parsed!.ruleHealth!.items.length, 1);
  assert.equal(parsed!.ruleHealth!.items[0].status, "violated");
  assert.equal(parsed!.ruleHealth!.summary.violated, 1);
});

test("a response WITHOUT rule_health does not produce fake health", () => {
  const parsed = parseSessionResult({
    ok: true,
    source_quality: "good",
    parser_confidence: { confidence: "high" },
    findings_count: 0,
    rules: { recommended: false },
  });
  assert.ok(parsed, "should still parse the result");
  assert.equal(parsed!.ruleHealth, null, "no rule_health => no panel");
});

test("evaluated:false parses through and maps to the honest empty-state copy", () => {
  const parsed = parseSessionResult({
    ok: true,
    findings_count: 0,
    rule_health: { evaluated: false, items: [], summary: {} },
  });
  assert.ok(parsed!.ruleHealth);
  assert.equal(parsed!.ruleHealth!.evaluated, false);
  // The panel renders RULE_HEALTH_EMPTY_COPY for evaluated:false (display test
  // covers the render; here we assert the contract the page relies on).
  assert.equal(RULE_HEALTH_EMPTY_COPY, "No loaded rules were evaluated for this session.");
});

test("extractRuleHealth rejects non-rule-health objects", () => {
  assert.equal(extractRuleHealth({ rule_health: { foo: 1 } }), null);
  assert.equal(extractRuleHealth({ rule_health: "nope" }), null);
  assert.equal(extractRuleHealth({}), null);
  assert.equal(extractRuleHealth(null), null);
});

test("parseSessionResultJson tolerates BOM and rejects junk", () => {
  const bom = String.fromCharCode(0xfeff);
  const parsed = parseSessionResultJson(bom + JSON.stringify(RESPONSE_WITH_HEALTH));
  assert.ok(parsed?.ruleHealth, "BOM-prefixed JSON should still parse");
  assert.equal(parseSessionResultJson("not json"), null);
  assert.equal(parseSessionResultJson(""), null);
  // A non-session object isn't a result.
  assert.equal(parseSessionResultJson(JSON.stringify({ hello: "world" })), null);
});

test("session-result page wires RuleHealthPanel to parsed data, gated on presence", () => {
  assert.match(PAGE_SRC, /RuleHealthPanel/);
  assert.match(PAGE_SRC, /parsed\.ruleHealth && <RuleHealthPanel ruleHealth=\{parsed\.ruleHealth\}/);
  assert.match(PAGE_SRC, /parseSessionResultJson/);
});

test("session-result page carries no overclaiming language", () => {
  for (const re of BANNED) {
    assert.ok(!re.test(PAGE_SRC), `session-result page must not contain ${re}`);
  }
});
