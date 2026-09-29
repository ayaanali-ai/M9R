// The service worker recycles content.js into the same tab whenever it restarts without a page reload (MV3 idles a
// worker after ~30s). window/document persist across that re-injection, so a naive listener would stack up and handle
// every event once per generation. This confirms only the newest generation actually acts.
// Native node:test VM fixture intentionally uses CommonJS in this .js test module.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const contentSrc = readFileSync(join(__dirname, "../extensions/browser/src/content.js"), "utf8");

function fakeListenerBus() {
  const listeners = [];
  return {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (index !== -1) listeners.splice(index, 1);
    },
    fire: (event, type) => { for (const entry of [...listeners]) if (!type || entry.type === type) entry.fn(event); },
    count: (type) => type ? listeners.filter((entry) => entry.type === type).length : listeners.length,
  };
}

// chrome.runtime.onMessage.addListener takes just the callback, unlike DOM addEventListener(type, fn).
function fakeSingleArgBus() {
  const listeners = [];
  return {
    addEventListener: (fn) => listeners.push(fn),
    removeListener: (fn) => { const index = listeners.indexOf(fn); if (index !== -1) listeners.splice(index, 1); },
    dispatch: (msg, sendResponse = () => {}) => [...listeners].map((fn) => fn(msg, {}, sendResponse)),
    fire: (msg) => { for (const fn of [...listeners]) fn(msg, {}, () => {}); },
    count: () => listeners.length,
  };
}

function inject(context) {
  runInNewContext(contentSrc, context);
}

function harness(registration) {
  const windowBus = fakeListenerBus();
  const docBus = fakeListenerBus();
  const runtimeBus = fakeSingleArgBus();
  const overlayUpdates = [];
  let root = null;
  const mountedFrames = [];
  let nativePointerResult = Promise.resolve(true);
  let overlaysDestroyed = 0;
  let overlaysSuspended = 0;
  let overlaysResumed = 0;
  const context = {
    window: {
      top: null, // set to itself below
      addEventListener: windowBus.addEventListener,
      M9RPresence: {
        ROOT_ID: "m9r-presence-root",
        createPresenceOverlay: () => {
          root = { dataset: {}, isConnected: true };
          return {
          destroy: () => { overlaysDestroyed += 1; if (root) root.isConnected = false; },
          update: (msg) => overlayUpdates.push(msg),
          isDoneVisible: (agent, sessionId) => {
            const latest = overlayUpdates.at(-1);
            return latest?.agent === agent && latest?.sessionId === sessionId && latest?.phase === "done" && latest?.step === "Done";
          },
          leave: () => {},
          setZoom: () => {},
          stop: () => {},
          suspend: () => { overlaysSuspended += 1; },
          resume: () => { overlaysResumed += 1; },
          talk: () => {},
          toggleComposer: () => {},
          togglePill: () => {},
          showComposer: () => {},
          whenArrived: () => Promise.resolve(),
          nativePointer: () => nativePointerResult,
          mountFrame: (...args) => mountedFrames.push(args),
          };
        },
      },
    },
    document: {
      getElementById: (id) => id === "m9r-presence-root" ? root : null, // background.js removes the old host before every re-injection
      addEventListener: docBus.addEventListener,
      removeEventListener: docBus.removeEventListener,
    },
    chrome: {
      runtime: {
        sendMessage: (msg, cb) => {
          if (msg?.type === "m9r-pill-register" && registration) {
            return registration.error ? Promise.reject(registration.error) : Promise.resolve(registration.reply);
          }
          if (cb) cb(undefined);
        },
        lastError: undefined,
        onMessage: { addListener: runtimeBus.addEventListener },
        ...(registration ? { getURL: (path) => `chrome-extension://test-id/${path}` } : {}),
      },
    },
    crypto: { getRandomValues: (bytes) => { bytes.fill(1); return bytes; } },
    Symbol,
    console,
    requestAnimationFrame: (callback) => setImmediate(callback),
    clearTimeout,
  };
  context.window.top = context.window;
  context.window.removeEventListener = windowBus.removeEventListener;
  context.chrome.runtime.onMessage.removeListener = runtimeBus.removeListener;
  return {
    context, windowBus, docBus, runtimeBus, overlayUpdates, getRoot: () => root, mountedFrames,
    setNativePointerResult: (value) => { nativePointerResult = value; },
    destroyed: () => overlaysDestroyed,
    suspended: () => overlaysSuspended,
    resumed: () => overlaysResumed,
  };
}

test("pill registration reports accepted status and mounts both frames", async () => {
  const { context, getRoot, mountedFrames } = harness({ reply: { ok: true } });
  inject(context);
  const root = getRoot();
  assert.equal(root.dataset.m9rRegistration, "pending");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.dataset.m9rRegistration, "accepted");
  assert.equal(mountedFrames.length, 2);
  assert.ok(mountedFrames.every(([, src]) => !src.includes("fixture") && src.includes("?n=")));
});

test("pill registration exposes a rejected result without echoing service-worker details", async () => {
  const { context, getRoot, mountedFrames } = harness({ reply: { ok: false, error: "not allowed" } });
  inject(context);
  await new Promise((resolve) => setImmediate(resolve));
  const root = getRoot();
  assert.equal(root.dataset.m9rRegistration, "rejected");
  assert.equal(mountedFrames.length, 0);
});

test("pill registration exposes a transport failure without exposing exception text", async () => {
  const { context, getRoot, mountedFrames } = harness({ error: new Error("private runtime detail") });
  inject(context);
  await new Promise((resolve) => setImmediate(resolve));
  const root = getRoot();
  assert.equal(root.dataset.m9rRegistration, "error");
  assert.equal(mountedFrames.length, 0);
  assert.equal(JSON.stringify(root.dataset).includes("private runtime detail"), false);
});

test("arrival acknowledgment waits for the visible native cursor render", async () => {
  const { context, runtimeBus, setNativePointerResult } = harness();
  inject(context);
  let finishPaint;
  setNativePointerResult(new Promise((resolve) => { finishPaint = resolve; }));
  let response;
  const returns = runtimeBus.dispatch({ type: "m9r-native-pointer", agent: "codex", x: 20, y: 40, active: true, phase: "arrived" }, (value) => { response = value; });

  assert.deepEqual(returns, [true]);
  assert.equal(response, undefined);
  finishPaint(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { painted: true });
});

test("repeated injection removes prior listeners and leaves exactly one active generation", () => {
  const { context, windowBus, docBus, runtimeBus, overlayUpdates, destroyed } = harness();
  for (let i = 0; i < 4; i++) inject(context);

  assert.equal(docBus.count(), 1);
  assert.equal(docBus.count("m9r:presence"), 1);
  assert.equal(runtimeBus.count(), 1);
  assert.equal(windowBus.count("keydown"), 1, "only the current generation owns its keyboard listener");
  assert.equal(windowBus.count("keyup"), 1, "only the current generation owns its keyboard listener");
  assert.equal(windowBus.count("pagehide"), 1, "the document-level lifecycle hook remains a singleton");
  assert.equal(windowBus.count("pageshow"), 1, "the document-level lifecycle hook remains a singleton");
  assert.equal(destroyed(), 3);

  docBus.fire({ detail: { type: "state", agent: "codex" } });
  assert.equal(overlayUpdates.length, 1, "only the current generation's overlay actually receives the event, not one per generation");

  runtimeBus.fire({ type: "presence", agent: "codex", phase: "start" });
  assert.equal(overlayUpdates.length, 2, "the runtime message likewise reaches only the current generation");
});

test("a broker Done notice reaches the current overlay exactly once after repeated injection", () => {
  const { context, runtimeBus, overlayUpdates } = harness();
  for (let i = 0; i < 4; i++) inject(context);

  runtimeBus.fire({ type: "presence", agent: "codex", provider: "codex-cli", phase: "done", step: "Done" });

  assert.equal(overlayUpdates.length, 1, "one live runtime listener forwards the completion notice");
  assert.deepEqual(JSON.parse(JSON.stringify(overlayUpdates[0])), {
    type: "presence",
    agent: "codex",
    provider: "codex-cli",
    phase: "done",
    step: "Done",
  });
});

test("a Done notice acknowledges only after the current overlay confirms the matching session was painted", async () => {
  const { context, runtimeBus } = harness();
  inject(context);
  let response;
  const returns = runtimeBus.dispatch({
    type: "presence", agent: "codex", provider: "codex-cli", sessionId: "session-done",
    phase: "done", step: "Done",
  }, (value) => { response = value; });

  assert.deepEqual(returns, [true]);
  assert.equal(response, undefined, "the extension must wait for a render frame before confirming completion");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { rendered: true });
});

test("a single injection (the normal case) still handles events exactly once", () => {
  const { context, docBus, overlayUpdates } = harness();
  inject(context);
  docBus.fire({ detail: { type: "state", agent: "claude" } });
  assert.equal(overlayUpdates.length, 1);
});

test("an invalidated Chrome runtime does not prevent DOM listener and overlay cleanup", () => {
  const { context, docBus, runtimeBus, overlayUpdates, destroyed } = harness();
  inject(context);
  context.chrome.runtime.onMessage.removeListener = () => { throw new Error('Extension context invalidated'); };
  inject(context);
  assert.equal(docBus.count(), 1);
  assert.equal(destroyed(), 1);
  docBus.fire({ detail: { type: 'state', agent: 'codex' } });
  runtimeBus.fire({ type: 'presence', agent: 'codex' });
  assert.equal(overlayUpdates.length, 2, 'stale runtime listener remains inert when Chrome refuses removal');
});

test("an invalidated runtime bridge is reused across repeated reinjection instead of leaking callbacks", () => {
  const { context, runtimeBus, overlayUpdates } = harness();
  inject(context);
  context.chrome.runtime.onMessage.removeListener = () => { throw new Error('Extension context invalidated'); };

  inject(context);
  inject(context);
  inject(context);

  assert.equal(runtimeBus.count(), 1, "only one runtime callback remains when Chrome refuses removal");
  runtimeBus.fire({ type: "presence", agent: "codex" });
  assert.equal(overlayUpdates.length, 1, "the retained bridge dispatches only to the current generation");
});

test("a BFCache restore revalidates the current overlay without stacking page lifecycle listeners", () => {
  const { context, windowBus, suspended, resumed } = harness();
  inject(context);

  windowBus.fire({ persisted: true }, "pagehide");
  windowBus.fire({ persisted: true }, "pageshow");
  assert.equal(suspended(), 1);
  assert.equal(resumed(), 1);

  // A service-worker restart can reinject content.js while this SPA/BFCache document survives.
  inject(context);
  assert.equal(windowBus.count("pagehide"), 1);
  assert.equal(windowBus.count("pageshow"), 1);
  windowBus.fire({ persisted: true }, "pageshow");
  assert.equal(resumed(), 2, "pageshow targets the replacement overlay after reinjection");
});
