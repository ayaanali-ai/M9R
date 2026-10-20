import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundInputLease } from "../src/lib/native/foreground-input-lease";

test("foreground input lease serializes competing owners in FIFO order", async () => {
  const lease = createForegroundInputLease();
  const order: string[] = [];
  let release!: () => void;
  const first = lease.run("paint", undefined, async () => {
    order.push("paint:start");
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("paint:end");
    return "painted";
  });
  const second = lease.run("calculator", undefined, async () => {
    order.push("calculator:start");
    return "calculated";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["paint:start"], "the second foreground owner must wait for the first");
  release();
  assert.equal(await first, "painted");
  assert.equal(await second, "calculated");
  assert.deepEqual(order, ["paint:start", "paint:end", "calculator:start"]);
});

test("an aborted waiter is removed without dispatching foreground input", async () => {
  const lease = createForegroundInputLease();
  const order: string[] = [];
  let release!: () => void;
  const first = lease.run("paint", undefined, async () => {
    order.push("paint:start");
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("paint:end");
  });
  const controller = new AbortController();
  const second = lease.run("calculator", controller.signal, async () => {
    order.push("calculator:dispatched");
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(second, /aborted|cancel/i);
  release();
  await first;
  assert.deepEqual(order, ["paint:start", "paint:end"]);
});

test("a foreground operation failure releases the lease for the next owner", async () => {
  const lease = createForegroundInputLease();
  const order: string[] = [];
  const failed = lease.run("paint", undefined, async () => {
    order.push("paint:start");
    throw new Error("paint delivery failed");
  });
  const next = lease.run("calculator", undefined, async () => {
    order.push("calculator:start");
    return true;
  });
  await assert.rejects(failed, /paint delivery failed/);
  assert.equal(await next, true);
  assert.deepEqual(order, ["paint:start", "calculator:start"]);
});
