import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTaskStageAction, runTaskStageAction } from "../src/lib/native/task-stage-actions";
import type { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { DesktopInputNotDispatchedError } from "../src/lib/native/desktop-input-errors";
import { createWebBrokerClient } from "../src/lib/native/web-broker-client";

test("desktop action parser accepts common pointer and keyboard actions but rejects malformed key input", () => {
  assert.deepEqual(parseTaskStageAction({ kind: "double_click", x: 24, y: 68 }), { kind: "double_click", x: 24, y: 68 });
  assert.deepEqual(parseTaskStageAction({ kind: "right_click", x: 24, y: 68 }), { kind: "right_click", x: 24, y: 68 });
  assert.deepEqual(parseTaskStageAction({ kind: "press_key", key: "Enter" }), { kind: "press_key", key: "Enter" });
  assert.deepEqual(parseTaskStageAction({ kind: "type_then_enter", view: "app", text: "search terms" }),
    { kind: "type_then_enter", view: "app", text: "search terms" });
  assert.throws(() => parseTaskStageAction({ kind: "type_then_enter", text: "search terms" }), /exact app view/);
  assert.throws(() => parseTaskStageAction({ kind: "type_then_enter", view: "app", text: "x".repeat(501) }), /Invalid stage input text/);
  assert.deepEqual(parseTaskStageAction({ kind: "hotkey", keys: ["Control", "L"] }), { kind: "hotkey", keys: ["Control", "L"] });
  assert.throws(() => parseTaskStageAction({ kind: "press_key", key: "not-a-key" }), /Invalid key/);
  assert.throws(() => parseTaskStageAction({ kind: "hotkey", keys: ["Control", "L", "Shift", "F2", "F3"] }), /1–4/);
  assert.throws(() => parseTaskStageAction({ kind: "click", x: 1, y: 2, hwnd: "123" }), /Invalid stage action fields/);
});

test("type-then-Enter is one exact app-stage batch and reports a typed pre-dispatch refusal on step two as partial", async () => {
  const identity = { handle: "codex", sessionId: "session" };
  const calls: string[] = [];
  const proof = { capture: { dataUrl: "data:image/png;base64,eA==", width: 1, height: 1, capturedAt: new Date(0).toISOString() } };
  const driver = {
    typeText: async (_name: string, text: string, _identity: unknown, options?: unknown) => {
      calls.push(`type:${text}:${JSON.stringify(options)}`); return proof;
    },
    pressKey: async (_name: string, key: string, _identity: unknown, options?: unknown) => {
      calls.push(`key:${key}:${JSON.stringify(options)}`); return proof;
    },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const complete = await runTaskStageAction(driver, "preview", { kind: "type_then_enter", view: "app", text: "query" }, identity);
  assert.deepEqual(calls, ["type:query:{\"deliveryMode\":\"owner-preview\"}", "key:Enter:{\"deliveryMode\":\"owner-preview\"}"]);
  assert.deepEqual((complete as { batchOutcome: unknown }).batchOutcome, { status: "complete", completedSteps: 2, totalSteps: 2 });

  calls.length = 0;
  const refusesEnter = { ...driver, pressKey: async () => {
    calls.push("key:Enter"); throw new DesktopInputNotDispatchedError("Owner interaction paused before Enter; no key was sent.", "foreground-lease");
  } } as unknown as ReturnType<typeof createCuaStageDriver>;
  const partial = await runTaskStageAction(refusesEnter, "preview", { kind: "type_then_enter", view: "app", text: "query" }, identity);
  assert.equal(calls.length, 2, "the key adapter is consulted, but its typed refusal guarantees that Enter was not dispatched");
  assert.match(calls[0]!, /^type:query:/);
  assert.equal(calls[1], "key:Enter");
  assert.deepEqual((partial as { batchOutcome: unknown }).batchOutcome, { status: "partial", completedSteps: 1, totalSteps: 2,
    stoppedAt: "enter", message: "Owner interaction paused before Enter; no key was sent." });

  const refusesText = { ...driver, typeText: async () => {
    throw new DesktopInputNotDispatchedError("The exact input target changed; no text was sent.", "target-identity");
  }, pressKey: async () => { calls.push("unexpected key"); return proof; } } as unknown as ReturnType<typeof createCuaStageDriver>;
  await assert.rejects(runTaskStageAction(refusesText, "preview", { kind: "type_then_enter", view: "app", text: "query" }, identity),
    (error: unknown) => error instanceof DesktopInputNotDispatchedError && error.dispatchState === "not-dispatched");
  assert.equal(calls.includes("unexpected key"), false, "the key step never runs after a typed text refusal");
});

test("owner-preview actions route through desktop-wide driver methods", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const proof = { capture: { dataUrl: "data:image/png;base64,eA==", width: 1, height: 1, capturedAt: new Date(0).toISOString() }, outcome: { status: "confirmed" as const } };
  const driver = {
    captureDesktop: async (...args: unknown[]) => { calls.push({ method: "captureDesktop", args }); return proof.capture; },
    moveDesktopCursor: async (...args: unknown[]) => { calls.push({ method: "moveDesktopCursor", args }); return { capture: proof.capture, cursor: {} }; },
    clickDesktop: async (...args: unknown[]) => { calls.push({ method: "clickDesktop", args }); return proof; },
    typeTextDesktop: async (...args: unknown[]) => { calls.push({ method: "typeTextDesktop", args }); return proof; },
    scrollDesktop: async (...args: unknown[]) => { calls.push({ method: "scrollDesktop", args }); return proof; },
    dragDesktop: async (...args: unknown[]) => { calls.push({ method: "dragDesktop", args }); return proof; },
    pressKeyDesktop: async (...args: unknown[]) => { calls.push({ method: "pressKeyDesktop", args }); return proof; },
    hotkeyDesktop: async (...args: unknown[]) => { calls.push({ method: "hotkeyDesktop", args }); return proof; },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const identity = { handle: "codex", sessionId: "session" };

  await runTaskStageAction(driver, "preview", { kind: "double_click", x: 12, y: 18 }, identity, "owner-preview");
  await runTaskStageAction(driver, "preview", parseTaskStageAction({ kind: "type", text: "echo M9R_TERM_OK" }), identity, "owner-preview");
  await runTaskStageAction(driver, "preview", { kind: "hotkey", keys: ["Control", "L"] }, identity, "owner-preview");
  await runTaskStageAction(driver, "preview", { kind: "cursor", x: 30, y: 45 }, identity);
  assert.deepEqual(calls.map((call) => call.method), ["clickDesktop", "typeTextDesktop", "hotkeyDesktop", "moveDesktopCursor"]);
  assert.deepEqual(calls[0]?.args, ["preview", 12, 18, identity, { count: 2, deliveryMode: "owner-preview" }]);
  assert.deepEqual(calls[1]?.args, ["preview", "echo M9R_TERM_OK", identity, { deliveryMode: "owner-preview" }]);
  assert.deepEqual(calls[3]?.args, ["preview", 30, 45, identity]);
});

test("broker client sends owner-preview when stage mode is omitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-broker-client-"));
  const keyPath = join(root, "broker.key");
  writeFileSync(keyPath, "test-key\n");
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = createWebBrokerClient({
    keyPath,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await client.prepareTaskStage!("test-token", "T2");
    await client.taskStageAction!("test-token", "T2", { kind: "capture" });
    await client.taskStageApp!("test-token", "T2", "chrome");
    assert.deepEqual(requests.map((request) => request.body.mode), ["owner-preview", "owner-preview", "owner-preview"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit app view targets the selected window while remaining in owner-preview mode", async () => {
  const calls: string[] = [];
  const driver = {
    capture: async () => { calls.push("app capture"); return {}; },
    click: async () => { calls.push("app click"); return {}; },
    typeText: async () => { calls.push("app type"); return {}; },
    captureDesktop: async () => { throw new Error("must not capture the owner's foreground instead"); },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const identity = { handle: "codex", sessionId: "session" };
  for (const value of [{ kind: "capture", view: "app" }, { kind: "click", view: "app", x: 20, y: 30 }, { kind: "type", view: "app", text: "hello" }]) {
    await runTaskStageAction(driver, "preview", parseTaskStageAction(value), identity);
  }
  assert.deepEqual(calls, ["app capture", "app click", "app type"]);
  assert.throws(() => parseTaskStageAction({ kind: "capture", view: "other-user-window" }), /Invalid stage action view/);
});

test("owner-preview app actions preserve semantic delivery until foreground is explicit", async () => {
  const options: Array<{ confirmFocusForeground?: boolean }> = [];
  const driver = { clickElement: async (_name: string, _ref: string, _identity: unknown, value: { confirmFocusForeground?: boolean }) => { options.push(value); } } as unknown as ReturnType<typeof createCuaStageDriver>;
  const identity = { handle: "codex", sessionId: "session" };
  await runTaskStageAction(driver, "preview", { kind: "click_element", ref: "e1", view: "app" }, identity);
  await runTaskStageAction(driver, "preview", { kind: "click_element", ref: "e1", view: "app", confirmFocusForeground: true }, identity);
  assert.equal(options[0].confirmFocusForeground, undefined);
  assert.equal(options[1].confirmFocusForeground, true);
  await assert.rejects(runTaskStageAction(driver, "preview", { kind: "click_element", ref: "e1", view: "app", confirmFocusForeground: true }, identity, "background"), /safe background delivery/);
  assert.equal(options.length, 2, "background refusal must happen before dispatch");
});
