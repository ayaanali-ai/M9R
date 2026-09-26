import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const background = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../extensions/browser/src/background.js"), "utf8");

function createHarness() {
  const sockets = [];
  const timers = [];
  const bridge = {
    options: null,
    openCount: 0,
    closeCount: 0,
    init(options) { this.options = options; },
    brokerOpen() { this.openCount += 1; },
    brokerClosed() { this.closeCount += 1; },
    send() {},
    state() {},
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) { this.sent.push(JSON.parse(payload)); }
    close(code, reason) { this.readyState = 3; this.closedWith = { code, reason }; this.onclose?.(); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }

  const chrome = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { getURL: (path) => `chrome-extension://m9r/${path}`, onMessage: { addListener() {} } },
    storage: {
      session: { async get() { return {}; }, async set() {} },
      local: { async get() { return {}; } },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
      async query() { return []; },
      async get() { throw new Error("tab not found"); },
      async sendMessage() {},
    },
    tabGroups: { async query() { return []; } },
  };

  const context = {
    chrome,
    WebSocket: FakeWebSocket,
    M9RPillBridge: bridge,
    importScripts() {},
    setTimeout(callback, ms) { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    URL,
    URLSearchParams,
    M9RPermissionLogic: {
      normalizeOrigin(url) { try { return new URL(url).origin; } catch { return null; } },
      permissionPattern(origin) { return `${origin}/*`; },
      mayActOnUrl(url) { return /^https?:\/\//.test(url); },
      pathWithinGrant() { return true; },
    },
  };

  runInNewContext(background, context);
  return { bridge, socket: sockets[0], timers };
}

async function settleExtensionStartup() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("extension reports ready only after the broker acknowledges the authenticated ready handshake", async () => {
  const h = createHarness();
  assert.equal(h.bridge.options.connected(), false);

  h.socket.open();
  h.socket.receive({ type: "broker-state", stopped: false });
  assert.equal(h.bridge.options.connected(), false, "an unsolicited state frame before the ready handshake is not accepted");
  await settleExtensionStartup();

  assert.deepEqual(JSON.parse(JSON.stringify(h.socket.sent)), [{ type: "ready" }]);
  assert.equal(h.bridge.options.connected(), false, "an open port is not broker readiness");
  assert.equal(h.bridge.openCount, 0, "the pill must not advertise readiness before broker acceptance");

  h.socket.receive({ type: "broker-state", stopped: false });
  assert.equal(h.bridge.options.connected(), true);
  assert.equal(h.bridge.openCount, 1);
});

test("extension ignores broker commands until the authenticated readiness acknowledgment arrives", async () => {
  const h = createHarness();
  h.socket.open();
  await settleExtensionStartup();

  h.socket.receive({ type: "command", id: "before-ready", action: "not-a-real-action" });
  await Promise.resolve();
  assert.equal(h.socket.sent.some((message) => message.type === "result" && message.id === "before-ready"), false);

  h.socket.receive({ type: "broker-state", stopped: false });
  h.socket.receive({ type: "command", id: "after-ready", action: "not-a-real-action" });
  await settleExtensionStartup();
  assert.equal(h.socket.sent.some((message) => message.type === "result" && message.id === "after-ready"), true);
});

test("an open socket that never completes the readiness handshake is closed", async () => {
  const h = createHarness();
  h.socket.open();
  await settleExtensionStartup();

  const timeout = h.timers.find((timer) => timer.ms === 5000);
  assert.ok(timeout, "a bounded readiness timeout prevents a fake or hung listener from appearing ready");
  timeout.callback();
  assert.equal(h.socket.closedWith?.code, 4001);
  assert.equal(h.bridge.options.connected(), false);
});
