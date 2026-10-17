import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareTaskStageNotice } from "../src/lib/native/task-stage-notice";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";

function withPolicyRoot(handle: string, run: (root: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-notice-"));
  writeFileSync(join(root, "task-stage-policy.json"), JSON.stringify({ version: 1, handles: [handle] }));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("the injected stage notice explicitly forbids falling back to the agent's own built-in computer-use", () => withPolicyRoot("codex", async (root) => {
  // Confirmed live: Codex fell back to OpenAI's own built-in computer-use for an unrelated
  // File Explorer task after an earlier, separate Chrome task failed over the (now-disabled)
  // browser extension route. The injected notice never told it not to -- m9r_web_open's own
  // description warns against the wrong M9R sub-route, but nothing warned against leaving
  // M9R's tools entirely. This asserts the explicit instruction is actually present.
  const web = { prepareTaskStage: async () => {} } as unknown as WebBrokerClient;
  const notice = await prepareTaskStageNotice(root, web, "tok", "codex", "T1");
  assert.match(notice, /never your own provider's built-in computer-use/i);
  assert.match(notice, /even as a fallback after an M9R action fails/i);
  assert.match(notice, /do not switch to a different automation system/i);
}));

test("the stage notice is empty for a handle without task-stage access", () => withPolicyRoot("codex", async (root) => {
  const web = { prepareTaskStage: async () => {} } as unknown as WebBrokerClient;
  const notice = await prepareTaskStageNotice(root, web, "tok", "claude", "T1");
  assert.equal(notice, "");
}));

test("the stage notice reports an unavailable broker instead of throwing", () => withPolicyRoot("codex", async (root) => {
  const notice = await prepareTaskStageNotice(root, undefined, "tok", "codex", "T1");
  assert.match(notice, /owner-launched broker is not connected/);
}));
