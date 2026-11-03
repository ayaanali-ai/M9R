import test from "node:test";
import assert from "node:assert/strict";
import { runComputerUseProgram } from "../src/lib/native/computer-use-program.ts";

test("computer-use programs compose broker-scoped observations and actions", async () => {
  const calls: string[] = [];
  const result = await runComputerUseProgram({ code: `
    const first = await m9r.observe({ target: "desktop" });
    const second = await m9r.act({ operationId: "op-1", targetId: first.targetId, targetRevision: first.targetRevision, kind: "observe" });
    return { first, second };
  ` }, {
    async observe(input) { calls.push(`observe:${String(input.target)}`); return { targetId: "target-1", targetRevision: "rev-1" }; },
    async act(input) { calls.push(`act:${String(input.operationId)}`); return { ok: true }; },
    async sleep() {},
  });
  assert.deepEqual(calls, ["observe:desktop", "act:op-1"]);
  assert.equal(result.calls, 2);
  assert.deepEqual(result.value, { first: { targetId: "target-1", targetRevision: "rev-1" }, second: { ok: true } });
});

test("computer-use programs enforce a bounded call budget", async () => {
  await assert.rejects(
    runComputerUseProgram({ maxCalls: 1, code: `await m9r.observe({ target: "desktop" }); await m9r.observe({ target: "desktop" });` }, {
      async observe() { return {}; }, async act() { return {}; }, async sleep() {},
    }),
    /Program call budget exceeded/,
  );
});

test("computer-use programs do not receive Node ambient capabilities", async () => {
  const result = await runComputerUseProgram({ code: `return { process: typeof process, require: typeof require, fetch: typeof fetch };` }, {
    async observe() { return {}; }, async act() { return {}; }, async sleep() {},
  });
  assert.deepEqual(result.value, { process: "undefined", require: "undefined", fetch: "undefined" });
});
