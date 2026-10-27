import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("separate provider workers share one foreground lease path", async () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-foreground-lease-"));
  const lockPath = join(home, "foreground-input-lease");
  const firstLease = createForegroundInputLease({ lockPath, pollMs: 1 });
  const secondLease = createForegroundInputLease({ lockPath, pollMs: 1 });
  const order: string[] = [];
  let release!: () => void;
  try {
    const first = firstLease.run("paint", undefined, async () => {
      order.push("paint:start");
      await new Promise<void>((resolve) => { release = resolve; });
      order.push("paint:end");
    });
    const second = secondLease.run("calculator", undefined, async () => {
      order.push("calculator:start");
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["paint:start"], "separate workers must not drive the foreground stream concurrently");
    assert.ok(existsSync(lockPath), "the shared lease must be visible while the first owner is active");
    release();
    await first;
    await second;
    assert.deepEqual(order, ["paint:start", "paint:end", "calculator:start"]);
    assert.equal(existsSync(lockPath), false, "the shared lease must be removed after release");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a dead foreground lease owner is reclaimed without touching unrelated files", async () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-foreground-stale-"));
  const lockPath = join(home, "foreground-input-lease");
  const unrelated = join(home, "unrelated.txt");
  mkdirSync(lockPath);
  writeFileSync(unrelated, "keep");
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead-owner", owner: "old-worker", startedAt: 1 }));
  try {
    const lease = createForegroundInputLease({ lockPath, pollMs: 1 });
    let ran = false;
    await lease.run("current-worker", undefined, async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(existsSync(lockPath), false);
    assert.equal(readFileSync(unrelated, "utf8"), "keep");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
