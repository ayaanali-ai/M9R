import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebBrokerClient } from "../src/lib/native/web-broker-client";

test("reports the native stage-helper error returned by the local broker", async () => withKey(async (keyPath) => {
  const helperError = "Native Windows desktop-stage operation “currentDesktop” timed out after 8 seconds; the helper was terminated.";
  const client = createWebBrokerClient({ keyPath, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: helperError }), { status: 403 }) });
  const result = await client.prepareTaskStage?.("session-token", "T4", "owner-preview");
  assert.deepEqual(result, { ok: false, error: helperError });
}));

test("distinguishes a request timeout from an unreachable broker", async () => withKey(async (keyPath) => {
  const client = createWebBrokerClient({ keyPath, fetchImpl: async () => { throw new DOMException("deadline", "TimeoutError"); } });
  const result = await client.prepareTaskStage?.("session-token", "T4", "owner-preview");
  assert.equal(result?.error, "The local M9R desktop-stage request timed out before the broker responded.");
}));

test("a dispatched stage timeout identifies the operation and directs verification instead of replay", async () => withKey(async (keyPath) => {
  const operationId = "mcp-operation-123";
  const client = createWebBrokerClient({ keyPath, fetchImpl: async () => { throw new DOMException("deadline", "TimeoutError"); } });
  const result = await client.taskStageAction?.("session-token", "T4", { kind: "click", x: 1, y: 2 }, "owner-preview", operationId);
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", new RegExp(operationId));
  assert.match(result?.error ?? "", /Do not replay it/);
  assert.match(result?.error ?? "", /Capture the stage and inspect/);
}));

test("stage action forwards its operation ID to the owner broker", async () => withKey(async (keyPath) => {
  let requestBody: Record<string, unknown> | undefined;
  const client = createWebBrokerClient({ keyPath, fetchImpl: async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } });
  await client.taskStageAction?.("session-token", "T4", { kind: "type", text: "hello" }, "owner-preview", "mcp-operation-456");
  assert.equal(requestBody?.operationId, "mcp-operation-456");
}));

test("uses the requested deadline for slow desktop-stage broker operations", async () => withKey(async (keyPath) => {
  const deadlines: number[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (milliseconds: number) => {
      deadlines.push(milliseconds);
      return new AbortController().signal;
    },
  });

  try {
    const client = createWebBrokerClient({
      keyPath,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    await client.taskStageApp?.("session-token", "T42", "wt");
    await client.taskStageAction?.("session-token", "T42", { kind: "capture" });
    await client.prepareTaskStage?.("session-token", "T42", "owner-preview", 42_000);
    assert.deepEqual(deadlines, [70_000, 70_000, 42_000]);
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, "timeout", descriptor);
  }
}));

test("reports a missing broker key without exposing the key path", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-client-"));
  try {
    const keyPath = join(root, "missing-key");
    const client = createWebBrokerClient({ keyPath, fetchImpl: async () => { throw new Error("fetch must not run"); } });
    const result = await client.prepareTaskStage?.("session-token", "T4", "owner-preview");
    assert.equal(result?.error, "The local M9R desktop-stage broker key could not be read.");
    assert.equal(result?.error?.includes(keyPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function withKey(run: (path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-client-"));
  const keyPath = join(root, "broker-key");
  writeFileSync(keyPath, "test-key", "utf8");
  return Promise.resolve(run(keyPath)).finally(() => rmSync(root, { recursive: true, force: true }));
}
