import assert from "node:assert/strict";
import test from "node:test";
import { findChrome } from "./bench/cdp-driver";
import { runScripted } from "./bench/scripted-runner";

test("scripted agents solve both tasks under all three conditions through the real tools and a real browser, and coordination never reads more pages than working in parallel", { skip: findChrome() ? false : "no Chrome or Edge installed", timeout: 240_000 }, async () => {
  const results = await runScripted({ seeds: [2], thinkMs: 0 });
  assert.equal(results.length, 6);
  for (const r of results) {
    assert.equal(r.error, undefined, `${r.task}/${r.condition}: ${r.error}`);
    assert.equal(r.correct, true, `${r.task}/${r.condition} must reach the right answer`);
  }
  const loads = (task: string, condition: string) => results.find((r) => r.task === task && r.condition === condition)!.pageLoads;
  for (const task of ["trip", "search"]) {
    assert.ok(loads(task, "coordinated") <= loads(task, "parallel"), `${task}: sharing findings can only reduce page loads`);
  }
  assert.ok(loads("trip", "solo") < loads("trip", "parallel"), "a solver that knows the constraints reads fewer pages than one that scans everything");
});
