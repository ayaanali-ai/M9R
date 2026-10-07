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
