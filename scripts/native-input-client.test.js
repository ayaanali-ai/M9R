// Native node:test VM fixture intentionally uses CommonJS in this .js test module.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const source = readFileSync(join(__dirname, "../extensions/browser/src/native-input-client.js"), "utf8");
const observeProgress = () => ({ painted: true });
const allowBeforeMouseDown = () => true;

function guardedClick(client, request, onProgress = observeProgress, options = {}) {
  return client.click(request, onProgress, { beforeMouseDown: allowBeforeMouseDown, ...options });
}

function eventSlot() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

function createClient({ connectError, timeoutMs = 500 } = {}) {
  const ports = [];
  const runtime = {
    lastError: null,
    connectNative(name) {
      if (connectError) throw new Error(connectError);
      assert.equal(name, "com.m9r.native_input");
      const port = {
        onMessage: eventSlot(),
        onDisconnect: eventSlot(),
        messages: [],
        disconnectCalls: 0,
        postMessage(message) { this.messages.push(message); },
        disconnect() { this.disconnectCalls += 1; this.onDisconnect.emit(); },
      };
      ports.push(port);
      return port;
    },
  };
  const context = { console, setTimeout, clearTimeout };
  runInNewContext(source, context);
  return { client: context.M9RNativeInputClient.create(runtime, timeoutMs), ports, runtime };
}

function clickRequest(requestId, overrides = {}) {
  return { requestId, x: 12, y: 20, viewportWidth: 1024, viewportHeight: 768, button: "left", clickCount: 1, ...overrides };
}

async function waitForProgressAck(port, requestId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ack = port.messages.find((message) => message.type === "progressAck" && message.requestId === requestId);
    if (ack) return ack;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`native input client did not acknowledge visible pointer arrival for ${requestId}`);
}

test("trusted input client correlates results, streams pointer progress, and reuses its MV3 port", async () => {
  const { client, ports } = createClient();
  const progress = [];
  const first = guardedClick(client, clickRequest("first_1"), (event) => { progress.push(event); return { painted: true }; });
  assert.equal(ports.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ports[0].messages[0])), { type: "click", ...clickRequest("first_1") });
  ports[0].onMessage.emit({ type: "progress", requestId: "first_1", x: 4, y: 8 });
  ports[0].onMessage.emit({ type: "progress", requestId: "first_1", sequence: 2, phase: "arrived", x: 12, y: 20 });
  await waitForProgressAck(ports[0], "first_1");
  ports[0].onMessage.emit({ type: "result", requestId: "first_1", ok: true, arrivalSequence: 2 });
  await first;
  assert.deepEqual(progress.map(({ x, y }) => ({ x, y })), [{ x: 4, y: 8 }, { x: 12, y: 20 }]);

  const second = guardedClick(client, clickRequest("second_2"));
  assert.equal(ports.length, 1);
  ports[0].onMessage.emit({ type: "progress", requestId: "second_2", sequence: 1, phase: "arrived", x: 12, y: 20 });
  await waitForProgressAck(ports[0], "second_2");
  ports[0].onMessage.emit({ type: "result", requestId: "second_2", ok: true, arrivalSequence: 1 });
  await second;
});

test("trusted input client refuses invalid and duplicate request identities", async () => {
  const { client, ports } = createClient();
  await assert.rejects(client.click(clickRequest("../bad")), /invalid trusted-click request identity/);
  const first = guardedClick(client, clickRequest("same"));
  await assert.rejects(client.click(clickRequest("same")), /duplicate trusted-click request identity/);
  ports[0].onMessage.emit({ type: "progress", requestId: "same", sequence: 1, phase: "arrived", x: 12, y: 20 });
  await waitForProgressAck(ports[0], "same");
  ports[0].onMessage.emit({ type: "result", requestId: "same", ok: true, arrivalSequence: 1 });
  await first;
});

test("trusted input client refuses clicks without a visible pointer progress observer", async () => {
  const { client, ports } = createClient();
  await assert.rejects(client.click(clickRequest("no_observer")), /requires a visible pointer progress handler/);
  assert.equal(ports.length, 0, "input must not connect to the native host without cursor synchronization");
});

test("trusted input client refuses to queue a stale click behind an in-flight click", async () => {
  const { client, ports } = createClient();
  const first = guardedClick(client, clickRequest("first"));
  const second = guardedClick(client, clickRequest("second"));
  const secondOutcome = second.then(() => "resolved", (error) => error.message);
  const postedWhileBusy = ports[0].messages.length;

  ports[0].onMessage.emit({ type: "progress", requestId: "first", sequence: 1, phase: "arrived", x: 12, y: 20 });
  await waitForProgressAck(ports[0], "first");
  ports[0].onMessage.emit({ type: "result", requestId: "first", ok: true, arrivalSequence: 1 });
  ports[0].onMessage.emit({ type: "result", requestId: "second", ok: true });
  await first;

  assert.equal(postedWhileBusy, 1, "a second OS click must not be queued behind the first");
  assert.equal(await secondOutcome, "another trusted click is already in progress");
});

test("trusted input client acknowledges pointer arrival only after the visible cursor update settles", async () => {
  const { client, ports } = createClient();
  const click = guardedClick(client, clickRequest("arrival"), () => new Promise((resolve) => setTimeout(() => resolve({ painted: true }), 5)));
  const port = ports[0];
  port.onMessage.emit({ type: "progress", requestId: "arrival", sequence: 1, phase: "arrived", x: 12, y: 20 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(port.messages.some((message) => message.type === "progressAck"), false);

  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(JSON.parse(JSON.stringify(port.messages.at(-1))), {
    type: "progressAck", requestId: "arrival", sequence: 1,
  });
  port.onMessage.emit({ type: "result", requestId: "arrival", ok: true, arrivalSequence: 1 });
  await click;
});

test("trusted input client runs final validation immediately before acknowledging pointer arrival", async () => {
  const { client, ports } = createClient();
  const validations = [];
  const click = client.click(clickRequest("pre_mouse_down"), observeProgress, {
    beforeMouseDown(progress) {
      validations.push(progress);
      return true;
    },
  });
  const port = ports[0];
  port.onMessage.emit({ type: "progress", requestId: "pre_mouse_down", sequence: 3, phase: "arrived", x: 12, y: 20 });
  const ack = await waitForProgressAck(port, "pre_mouse_down");

  assert.equal(validations.length, 1, "the final guard runs once for the final pointer arrival");
  assert.equal(validations[0].sequence, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(ack)), {
    type: "progressAck", requestId: "pre_mouse_down", sequence: 3,
  });
  port.onMessage.emit({ type: "result", requestId: "pre_mouse_down", ok: true, arrivalSequence: 3 });
  await click;
});

test("trusted input client refuses to connect without a pre-mousedown safety validator", async () => {
  const { client, ports } = createClient();
  await assert.rejects(client.click(clickRequest("missing_guard"), observeProgress), /pre-mousedown safety validator/);
  assert.equal(ports.length, 0, "the native host must not receive an unguarded click request");
});

test("trusted input client rejects a success response that did not follow acknowledged cursor arrival", async () => {
  const { client, ports } = createClient();
  const click = guardedClick(client, clickRequest("missing_arrival"));
  ports[0].onMessage.emit({ type: "result", requestId: "missing_arrival", ok: true, arrivalSequence: 1 });

  await assert.rejects(click, /without acknowledged cursor arrival/);
  assert.equal(ports[0].disconnectCalls, 1);
  assert.equal(client.pendingCount(), 0);
});

test("trusted input client refuses arrival when the visible cursor cannot confirm its render", async () => {
  const { client, ports } = createClient();
  const click = guardedClick(client, clickRequest("not_painted"), () => ({ painted: false }));
  ports[0].onMessage.emit({ type: "progress", requestId: "not_painted", sequence: 1, phase: "arrived", x: 12, y: 20 });

  await assert.rejects(click, /visible cursor did not confirm its rendered arrival/);
  assert.equal(ports[0].messages.some((message) => message.type === "progressAck"), false);
  assert.equal(ports[0].disconnectCalls, 1);
});

test("trusted input timeout disconnects the host to cancel an unacknowledged OS action", async () => {
  const { client, ports } = createClient({ timeoutMs: 10 });
  await assert.rejects(guardedClick(client, clickRequest("timeout")), /timed out/);
  assert.equal(ports[0].disconnectCalls, 1);
  assert.equal(client.pendingCount(), 0);
});

test("trusted input abort closes the host connection and rejects the active click", async () => {
  const { client, ports } = createClient();
  const controller = new AbortController();
  const click = guardedClick(client, clickRequest("abort"), observeProgress, { signal: controller.signal });
  controller.abort();

  await assert.rejects(click, (error) => error.name === "AbortError");
  assert.equal(ports[0].disconnectCalls, 1);
  assert.equal(client.pendingCount(), 0);
});

test("trusted input abort during pointer arrival sends no late acknowledgment", async () => {
  const { client, ports } = createClient();
  const controller = new AbortController();
  const click = guardedClick(client, clickRequest("abort_arrival"), observeProgress, { signal: controller.signal });
  ports[0].onMessage.emit({ type: "progress", requestId: "abort_arrival", sequence: 1, phase: "arrived", x: 12, y: 20 });
  controller.abort();

  await assert.rejects(click, (error) => error.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ports[0].messages.some((message) => message.type === "progressAck"), false);
  assert.equal(ports[0].disconnectCalls, 1);
});

test("trusted input client reports missing host and host-side denials without a synthetic fallback", async () => {
  const missing = createClient({ connectError: "Specified native messaging host not found" });
  await assert.rejects(guardedClick(missing.client, clickRequest("missing")), /trusted input is unavailable/);
  const { client, ports } = createClient();
  const click = guardedClick(client, clickRequest("denied"));
  ports[0].onMessage.emit({ type: "result", requestId: "denied", ok: false, error: "the visible foreground window is not Chrome" });
  await assert.rejects(click, /foreground window is not Chrome/);
});

test("native host disconnection rejects in-flight work and the next click reconnects", async () => {
  const { client, ports } = createClient();
  const click = guardedClick(client, clickRequest("disconnect"));
  ports[0].onDisconnect.emit();
  await assert.rejects(click, /host disconnected/);
  const retry = guardedClick(client, clickRequest("retry"));
  assert.equal(ports.length, 2);
  ports[1].onMessage.emit({ type: "progress", requestId: "retry", sequence: 1, phase: "arrived", x: 12, y: 20 });
  await waitForProgressAck(ports[1], "retry");
  ports[1].onMessage.emit({ type: "result", requestId: "retry", ok: true, arrivalSequence: 1 });
  await retry;
});
