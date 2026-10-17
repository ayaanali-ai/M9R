import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stopChildProcess } from "./runtime-child-shutdown.mjs";

function createChild({ exitOnClose = false, exitOnKill = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {
    end() {
      if (exitOnClose) {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      }
    },
  };
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (exitOnKill) {
      queueMicrotask(() => {
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      });
    }
    return true;
  };
  return child;
}

test("closes stdin and waits for a graceful MCP child exit", async () => {
  const child = createChild({ exitOnClose: true });

  await stopChildProcess(child, { gracePeriodMs: 50, killTimeoutMs: 50 });

  assert.equal(child.exitCode, 0);
  assert.equal(child.killCalls, 0);
});

test("kills and waits for a child that ignores stdin close", async () => {
  const child = createChild({ exitOnKill: true });

  await stopChildProcess(child, { gracePeriodMs: 5, killTimeoutMs: 50 });

  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.killCalls, 1);
});

test("reports failure if the child survives forced termination", async () => {
  const child = createChild();

  await assert.rejects(
    stopChildProcess(child, { gracePeriodMs: 5, killTimeoutMs: 5 }),
    /did not exit after termination/,
  );
  assert.equal(child.killCalls, 1);
});

test("does not signal an already exited child", async () => {
  const child = createChild();
  child.exitCode = 0;

  await stopChildProcess(child, { gracePeriodMs: 5, killTimeoutMs: 5 });

  assert.equal(child.killCalls, 0);
});
