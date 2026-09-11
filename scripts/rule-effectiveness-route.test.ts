import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("approved dashboard evidence applies conservative rule effectiveness", () => {
  const source = readFileSync("src/app/api/agent/session/route.ts", "utf8");
  const submit = source.indexOf('const submission = await recordSubmission(agent, body, sessionText, activeRules, true, "human");');
  const linkage = source.indexOf("const runLinkage = await linkSessionToRun", submit);
  const section = source.slice(submit, linkage);
  assert.match(section, /deriveRuleEffectiveness/);
  assert.match(section, /applyRuleEffectivenessDecision/);
  assert.match(section, /Promise\.all/);
});
