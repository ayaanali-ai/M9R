import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTaskStageAction, runTaskStageAction } from "../src/lib/native/task-stage-actions";
import type { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { createWebBrokerClient } from "../src/lib/native/web-broker-client";

test("desktop action parser accepts common pointer and keyboard actions but rejects malformed key input", () => {
  assert.deepEqual(parseTaskStageAction({ kind: "double_click", x: 24, y: 68 }), { kind: "double_click", x: 24, y: 68 });
  assert.deepEqual(parseTaskStageAction({ kind: "right_click", x: 24, y: 68 }), { kind: "right_click", x: 24, y: 68 });
  assert.deepEqual(parseTaskStageAction({ kind: "read_structure", view: "app" }), { kind: "read_structure", view: "app" });
  assert.deepEqual(parseTaskStageAction({ kind: "press_key", key: "Enter" }), { kind: "press_key", key: "Enter" });
  assert.deepEqual(parseTaskStageAction({ kind: "hotkey", keys: ["Control", "L"] }), { kind: "hotkey", keys: ["Control", "L"] });
  assert.throws(() => parseTaskStageAction({ kind: "press_key", key: "not-a-key" }), /Invalid key/);
  assert.throws(() => parseTaskStageAction({ kind: "hotkey", keys: ["Control", "L", "Shift", "F2", "F3"] }), /1–4/);
  assert.throws(() => parseTaskStageAction({ kind: "click", x: 1, y: 2, hwnd: "123" }), /Invalid stage action fields/);
});

test("stage parser accepts the provider-neutral semantic action contract", () => {
  const actions = [
    { kind: "click_element", view: "app", ref: "uia:button", confirmFocusForeground: true },
    { kind: "replace_element", view: "app", ref: "uia:field", text: "hello" },
    { kind: "scroll_delta", view: "app", x: 20, y: 30, deltaX: 0, deltaY: 2, unit: "page", confirmFocusForeground: true },
    { kind: "window_frame", view: "app", x: 10, y: 20, width: 800, height: 600 },
    { kind: "focus", view: "app", confirmFocusForeground: true },
    { kind: "invoke_menu", view: "app", path: ["Edit", "Select All"] },
    { kind: "clipboard_read", view: "app", includeText: false },
    { kind: "clipboard_write", view: "app", text: "hello", confirmSharedClipboard: true },
  ];
  for (const action of actions) assert.deepEqual(parseTaskStageAction(action), action);
});

test("structure observation is app-window-only and does not use desktop coordinates", async () => {
  const calls: string[] = [];
  const driver = {
    readStructure: async (...args: unknown[]) => { calls.push(JSON.stringify(args)); return { status: "complete", capturedAt: new Date(0).toISOString(), elements: [] }; },
    captureDesktop: async () => { throw new Error("desktop-wide structure is not allowed"); },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const identity = { handle: "codex", sessionId: "session" };
  const structure = await runTaskStageAction(driver, "preview", { kind: "read_structure", view: "app" }, identity, "owner-preview");
  assert.equal((structure as { status: string }).status, "complete");
  assert.deepEqual(calls, [["preview", identity]].map((value) => JSON.stringify(value)));
  assert.throws(() => parseTaskStageAction({ kind: "read_structure" }), /Invalid stage action fields/);
  assert.throws(() => parseTaskStageAction({ kind: "read_structure", view: "desktop" }), /exact app view/);
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
  assert.deepEqual(calls[0]?.args, ["preview", 12, 18, identity, { count: 2 }]);
  assert.deepEqual(calls[1]?.args, ["preview", "echo M9R_TERM_OK", identity]);
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
test("window placement accepts signed screen origins without allowing negative click coordinates", () => {
  assert.deepEqual(parseTaskStageAction({ kind: "window_frame", view: "app", x: -1200, y: -80, width: 800, height: 600 }),
    { kind: "window_frame", view: "app", x: -1200, y: -80, width: 800, height: 600 });
  assert.throws(() => parseTaskStageAction({ kind: "click", x: -1, y: 0 }), /coordinates/);
});
