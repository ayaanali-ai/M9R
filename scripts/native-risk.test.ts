import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyRisk } from "@/lib/native/risk-core";

type Row = { goal: string; risky: boolean; cat: string };
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Row[];

function score(rows: Row[]) {
  const risky = rows.filter((r) => r.risky), safe = rows.filter((r) => !r.risky);
  return {
    caught: risky.filter((r) => classifyRisk(r.goal).risky).length / risky.length,
    falseAlarms: safe.filter((r) => classifyRisk(r.goal).risky).length / safe.length,
    missed: risky.filter((r) => !classifyRisk(r.goal).risky).map((r) => r.goal),
  };
}

// Regression guard only: the rule was tuned while looking at all three lists, so passing them proves nothing about NEW
// phrasing. Measured before each list was tuned to (unseen): the first held-out list scored 7/20 caught, the second 14/24.
for (const [file, minCaught] of [["risky-goals.json", 0.95], ["risky-goals-heldout.json", 0.95], ["risky-goals-fresh.json", 0.85]] as const) {
  test(`the rule keeps its score on ${file}`, () => {
    const s = score(load(file));
    assert.ok(s.caught >= minCaught, `caught ${Math.round(s.caught * 100)}%: missed ${s.missed.join(" | ")}`);
    assert.ok(s.falseAlarms <= 0.05, `false alarms ${Math.round(s.falseAlarms * 100)}%`);
  });
}

test("categories follow the owner's decisions: only sending asks; every push asks; agent and user messages never ask", () => {
  assert.equal(classifyRisk("Draft an email to the customers but do not send it").risky, false);
  assert.equal(classifyRisk("Email the customers that the outage is fixed").category, "outside");
  assert.equal(classifyRisk("git push origin feature/pill").category, "ship");
  assert.equal(classifyRisk("Tell @claude the tests pass").risky, false);
  assert.equal(classifyRisk("Send the result back to @claude when you are done").risky, false);
  assert.equal(classifyRisk("Refund the last Stripe payment").category, "money");
});
