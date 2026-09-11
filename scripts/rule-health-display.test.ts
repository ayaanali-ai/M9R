/**
 * Rule Health — UI display tests
 * ----------------------------------------------------------------------------
 * The panel is a .tsx React component (JSX isn't transpiled by the node test
 * loader), so we test the pure display copy/policy it renders verbatim, and
 * statically assert the component wires that copy in and carries no overclaiming
 * language. This covers: violated renders clearly, not_applicable renders
 * clearly, the honest evaluated:false empty state, and no overclaiming.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { RuleHealthStatus } from "../src/lib/rule-health.ts";
import {
  RULE_HEALTH_EMPTY_COPY,
  STATUS_COPY,
  STATUS_LABEL,
  STATUS_TONE,
  STATUS_ORDER,
} from "../src/lib/rule-health-display.ts";

const ALL_STATUSES: RuleHealthStatus[] = [
  "followed",
  "violated",
  "not_applicable",
  "too_vague",
  "needs_review",
  "obsolete",
];

const PANEL_SRC = readFileSync(
  resolve(process.cwd(), "src/components/report/RuleHealthPanel.tsx"),
  "utf8",
);

// Words that would overclaim or imply a guarantee/compliance OathLock can't back.
const BANNED = [/guarantee/i, /proven success/i, /\bcompliant\b/i, /\bcompliance\b/i, /\bcertified\b/i];

test("every status has copy, label, and a tone", () => {
  for (const s of ALL_STATUSES) {
    assert.ok(STATUS_COPY[s] && STATUS_COPY[s].length > 0, `missing copy for ${s}`);
    assert.ok(STATUS_LABEL[s] && STATUS_LABEL[s].length > 0, `missing label for ${s}`);
    assert.ok(STATUS_TONE[s], `missing tone for ${s}`);
  }
  assert.equal(STATUS_ORDER.length, ALL_STATUSES.length);
  for (const s of ALL_STATUSES) assert.ok(STATUS_ORDER.includes(s), `${s} missing from order`);
});

test("violated status reads clearly and conservatively", () => {
  assert.equal(STATUS_LABEL.violated, "Violated");
  assert.match(STATUS_COPY.violated, /recurred while this rule was loaded/);
  assert.equal(STATUS_TONE.violated, "bad");
});

test("not_applicable status reads clearly", () => {
  assert.equal(STATUS_LABEL.not_applicable, "Not applicable");
  assert.match(STATUS_COPY.not_applicable, /did not touch the rule/);
  assert.equal(STATUS_TONE.not_applicable, "neutral");
});

test("followed copy is conservative — 'held', not 'worked/passed/guaranteed'", () => {
  assert.match(STATUS_COPY.followed, /Evidence suggests this rule held/);
  assert.ok(!/worked|passed|guarantee|proven/i.test(STATUS_COPY.followed));
});

test("honest empty-state copy exists for evaluated:false", () => {
  assert.equal(RULE_HEALTH_EMPTY_COPY, "No loaded rules were evaluated for this session.");
});

test("no overclaiming language anywhere in display copy", () => {
  const allCopy = [
    RULE_HEALTH_EMPTY_COPY,
    ...Object.values(STATUS_COPY),
    ...Object.values(STATUS_LABEL),
  ].join("\n");
  for (const re of BANNED) {
    assert.ok(!re.test(allCopy), `display copy must not contain ${re}`);
  }
});

test("RuleHealthPanel renders the copy helper and item fields, not ad-hoc strings", () => {
  // It must consume the tested copy maps...
  assert.match(PANEL_SRC, /STATUS_COPY/);
  assert.match(PANEL_SRC, /STATUS_LABEL/);
  assert.match(PANEL_SRC, /RULE_HEALTH_EMPTY_COPY/);
  // ...and surface the per-item evidence + reason + matched findings.
  assert.match(PANEL_SRC, /item\.reason/);
  assert.match(PANEL_SRC, /evidenceLevel/);
  assert.match(PANEL_SRC, /matchedFindingTypes/);
  // ...and gate on evaluated for the empty state.
  assert.match(PANEL_SRC, /ruleHealth\.evaluated/);
});

test("RuleHealthPanel source carries no overclaiming language", () => {
  for (const re of BANNED) {
    assert.ok(!re.test(PANEL_SRC), `panel must not contain ${re}`);
  }
});
