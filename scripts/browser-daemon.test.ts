import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserDaemon } from "../src/lib/native/browser-daemon";
import type { BrowserTransport } from "../src/lib/native/agent-chrome";

test("the production browser daemon launches once on demand and forwards exact messages", async () => {
  let starts = 0;
  let closes = 0;
  let receiver: (message: unknown) => void = () => {};
  const sent: unknown[] = [];
  const browser: BrowserTransport = { ready: () => true, send: (message) => { sent.push(message); return true; },
    subscribe: (receive) => { receiver = receive; return () => {}; }, close: async () => { closes++; } };
  const daemon = createBrowserDaemon(async () => { starts++; return browser; });
  const received: unknown[] = [];
  daemon.subscribe((message) => received.push(message), () => {});
  assert.equal(starts, 0);
  assert.equal(daemon.send({ tab: "one" }), false);
  assert.deepEqual(await Promise.all([daemon.ensureReady!(), daemon.ensureReady!()]), [true, true]);
  assert.equal(starts, 1);
  assert.equal(daemon.send({ tab: "two", action: "click" }), true);
  receiver({ tab: "two", delivered: true });
  assert.deepEqual(sent, [{ tab: "two", action: "click" }]);
  assert.deepEqual(received, [{ tab: "two", delivered: true }]);
  await daemon.close();
  assert.equal(closes, 1);
  assert.equal(await daemon.ensureReady!(), false);
});

test("a disconnected browser generation cannot be silently replaced or replay input", async () => {
  let connected = true;
  let starts = 0;
  const daemon = createBrowserDaemon(async () => { starts++; return { ready: () => connected, send: () => true, subscribe: () => () => {}, close: async () => {} }; });
  await daemon.ensureReady!();
  connected = false;
  assert.equal(await daemon.ensureReady!(), false);
  assert.equal(daemon.send({ action: "type" }), false);
  assert.equal(starts, 1);
  await daemon.close();
});
