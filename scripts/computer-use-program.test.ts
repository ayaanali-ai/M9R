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

test("an Error thrown by the sandboxed script is normalized to a host-realm Error", async () => {
  // The script runs in a separate vm context, so an Error it constructs with
  // its own `throw new Error(...)` is an instance of THAT context's Error,
  // not this (host) realm's Error. A caller doing `error instanceof Error`
  // (as computer-use-mcp.ts does to build its tool response) would see
  // false for the raw cross-realm error and fall back to a generic message,
  // discarding the real one -- runComputerUseProgram must re-throw a host
  // Error so that check succeeds.
  try {
    await runComputerUseProgram({ code: `throw new Error("canvas click rejected: no safe semantic action");` }, {
      async observe() { return {}; }, async act() { return {}; }, async sleep() {},
    });
    assert.fail("expected the program to reject");
  } catch (error) {
    assert.ok(error instanceof Error, "the rejection must be an instance of THIS realm's Error");
    assert.equal(error.message, "canvas click rejected: no safe semantic action");
  }
});

test("a timed-out program's still-running continuation can never reach a later m9r call", async () => {
  // vm's own `timeout` option only bounds synchronous execution; an awaited
  // m9r.sleep() keeps the script's async IIFE alive well past that, and
  // Promise.race never cancels the losing side. Without an abort flag, the
  // script would still be free to call m9r.act() (real desktop input) after
  // its caller already gave up and returned a timeout.
  const order: string[] = [];
  await assert.rejects(
    runComputerUseProgram({ timeoutMs: 20, code: `
      await m9r.sleep(60);
      await m9r.act({ afterTimeout: true });
    ` }, {
      async observe() { return {}; },
      async act(input) { order.push(`act:${String((input as Record<string, unknown>).afterTimeout)}`); return {}; },
      async sleep() {},
    }),
    /timed out/,
  );
  // Let the script's sleep(60) actually elapse and attempt its post-timeout act().
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(order, [], "no m9r call started after the host returned a timeout may ever reach the real desktop capability");
});

test("computer-use programs do not receive Node ambient capabilities", async () => {
  const result = await runComputerUseProgram({ code: `return { process: typeof process, require: typeof require, fetch: typeof fetch };` }, {
    async observe() { return {}; }, async act() { return {}; }, async sleep() {},
  });
  assert.deepEqual(result.value, { process: "undefined", require: "undefined", fetch: "undefined" });
});

test("a returned program cannot leave a background continuation that dispatches later input", async () => {
  const calls: string[] = [];
  const result = await runComputerUseProgram({ code: `
    void (async () => { await m9r.sleep(30); await m9r.act({ late: true }); })().catch(() => {});
    return "finished";
  ` }, { async observe() { return {}; }, async act() { calls.push("late input"); return {}; }, async sleep() {} });
  assert.equal(result.value, "finished");
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(calls, [], "a completed invocation no longer owns computer capabilities");
});
