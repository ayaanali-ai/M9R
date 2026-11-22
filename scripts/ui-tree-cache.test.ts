import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createWindowsDesktopStageManager as createManager } from "../src/lib/native/windows-desktop-stage";

// Item 6 of the latency plan: windowStructure() gets an event-driven cache, proven in shadow
// mode (always serving the real fetch, but comparing against what the cache would have served)
// before M9R_TRUST_UI_TREE_CACHE is ever turned on.

function withRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const fixtureRoot = resolve(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-ui-tree-cache-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function createWindowsDesktopStageManager(...args: Parameters<typeof createManager>): ReturnType<typeof createManager> {
  const manager = createManager(...args);
  const physical = new Set(["sendClick", "sendDrag", "sendScroll", "sendKeyCombo", "sendText"]);
  return new Proxy(manager, { get(target, key) {
    const method = Reflect.get(target, key);
    return physical.has(String(key)) ? (...values: unknown[]) => manager.withForegroundAuthorization(async () => {}, () => method(...values)) : method;
  } });
}

function oneElement(overrides: Partial<{ label: string; role: string }> = {}) {
  return {
    label: overrides.label ?? "OK", role: overrides.role ?? "button", className: "Button",
    automationId: "ok-button", depth: 1, path: [0], enabled: true, focused: false,
    rect: { x: 10, y: 10, width: 40, height: 20 },
  };
}

function fixtureInvokeNative(elementsRef: { current: ReturnType<typeof oneElement>[] }, calls: string[]) {
  let revision = 0;
  return async (request: Record<string, unknown>) => {
    calls.push(String(request.op));
    if (request.op === "inspect") return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
    if (request.op === "inspectWindowStructure") {
      revision += 1;
      return {
        ok: true,
        windowStructure: {
          scope: "window" as const, windowId: String(request.windowId), status: "complete" as const, truncated: false,
          elements: elementsRef.current.map((element, index) => ({ ...element, ref: `window-ui-element-${revision}-${index}` })),
        },
      };
    }
    if (request.op === "sendClick") return { ok: true };
    if (request.op === "setWindowFrame") return { ok: true, rect: { x: Number(request.x), y: Number(request.y), width: Number(request.width), height: Number(request.height) } };
    return { ok: false, error: `unhandled op ${request.op}` };
  };
}

test("shadow mode always serves a real fetch, and records a clean comparison when nothing changed", () => withRoot(async (root) => {
  const calls: string[] = [];
  const elementsRef = { current: [oneElement()] };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: fixtureInvokeNative(elementsRef, calls) });

  await manager.windowStructure(4321, "0x99");
  await manager.windowStructure(4321, "0x99");

  assert.equal(calls.filter((op) => op === "inspectWindowStructure").length, 2, "shadow mode (default) never skips the real native fetch");
  const stats = manager.uiTreeCacheStats();
  assert.equal(stats.trusted, false);
  assert.equal(stats.shadowCompared, 1, "the second call has a prior entry to shadow-compare against");
  assert.equal(stats.shadowMismatches, 0, "identical content (ignoring the snapshot-qualified ref) must not be flagged as a mismatch");
}));

test("shadow mode flags a real mismatch when the window's content actually changed between reads", () => withRoot(async (root) => {
  const calls: string[] = [];
  const elementsRef = { current: [oneElement({ label: "Loading" })] };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: fixtureInvokeNative(elementsRef, calls) });

  await manager.windowStructure(4321, "0x99");
  elementsRef.current = [oneElement({ label: "Done" })];
  await manager.windowStructure(4321, "0x99");

  const stats = manager.uiTreeCacheStats();
  assert.equal(stats.shadowCompared, 1);
  assert.equal(stats.shadowMismatches, 1);
}));

test("concurrent reads of the identical window and bounds coalesce into one native round trip", () => withRoot(async (root) => {
  const calls: string[] = [];
  const elementsRef = { current: [oneElement()] };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: fixtureInvokeNative(elementsRef, calls) });

  const [a, b] = await Promise.all([manager.windowStructure(4321, "0x99"), manager.windowStructure(4321, "0x99")]);

  assert.equal(calls.filter((op) => op === "inspectWindowStructure").length, 1, "two simultaneous identical requests must share one native fetch");
  assert.deepEqual(a, b);
  assert.equal(manager.uiTreeCacheStats().coalesced, 1);
}));

test("with M9R_TRUST_UI_TREE_CACHE=1, a fresh cache hit skips the native fetch entirely", () => withRoot(async (root) => {
  const calls: string[] = [];
  const elementsRef = { current: [oneElement()] };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: { M9R_TRUST_UI_TREE_CACHE: "1" }, invokeNative: fixtureInvokeNative(elementsRef, calls) });

  await manager.windowStructure(4321, "0x99");
  await manager.windowStructure(4321, "0x99");

  assert.equal(calls.filter((op) => op === "inspectWindowStructure").length, 1, "the second call must be served from cache, not re-fetched");
  const stats = manager.uiTreeCacheStats();
  assert.equal(stats.trusted, true);
  assert.equal(stats.hits, 1);
}));

test("a click on the same window invalidates its cache, so the next trusted read is real again", () => withRoot(async (root) => {
  const calls: string[] = [];
  const elementsRef = { current: [oneElement({ label: "Before" })] };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: { M9R_TRUST_UI_TREE_CACHE: "1" }, invokeNative: fixtureInvokeNative(elementsRef, calls) });

  await manager.windowStructure(4321, "0x99");
  await manager.sendClick(4321, "0x99", 10, 10);
  elementsRef.current = [oneElement({ label: "After" })];
  const second = await manager.windowStructure(4321, "0x99");

  assert.equal(calls.filter((op) => op === "inspectWindowStructure").length, 2, "the click must invalidate the cache entry so the post-click read is a real fetch");
  assert.equal(second.elements[0]?.label, "After");
}));

test("resizing a window invalidates its cache, so the next trusted read reflects the new layout", () => withRoot(async (root) => {
  // setWindowFrame changes every cached element's rect exactly like a click changes content --
  // it was the one UI-mutating dispatch path that never called invalidateWindowStructureCache,
  // harmless under the shadow-mode default (every call already does a real fetch) but a real
  // stale-rect bug the moment M9R_TRUST_UI_TREE_CACHE=1 is turned on.
  const calls: string[] = [];
  const elementsRef = { current: [oneElement({ label: "Before" })] };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: { M9R_TRUST_UI_TREE_CACHE: "1" }, invokeNative: fixtureInvokeNative(elementsRef, calls) });

  await manager.windowStructure(4321, "0x99");
  await manager.setWindowFrame(4321, "0x99", { x: 0, y: 0, width: 800, height: 600 });
  elementsRef.current = [oneElement({ label: "After" })];
  const second = await manager.windowStructure(4321, "0x99");

  assert.equal(calls.filter((op) => op === "inspectWindowStructure").length, 2, "the resize must invalidate the cache entry so the post-resize read is a real fetch");
  assert.equal(second.elements[0]?.label, "After");
}));
