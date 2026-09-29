// The "done" ring is the only signal, short of opening the panel, that a run actually finished instead of just going
// idle without ever having done anything -- confirms the state map that decides when it lights up.
// Native node:test VM fixture intentionally uses CommonJS in this .js test module.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const src = readFileSync(join(__dirname, "../extensions/browser/src/frame-common.js"), "utf8");

function load() {
  const windowListeners = new Map();
  const parentMessages = [];
  const parent = { postMessage: (data, targetOrigin) => parentMessages.push({ data, targetOrigin }) };
  const context = {
    URL,
    window: {
      parent,
      location: { href: "chrome-extension://test-id/pill.html?n=test-nonce" },
      addEventListener: (type, fn) => windowListeners.set(type, fn),
      M9RFrame: undefined,
    },
    document: {
      documentElement: { dataset: {} },
      createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, style: {}, dataset: {} }),
      addEventListener: () => {},
    },
    chrome: {
      runtime: { connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }), getURL: (p) => p },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    },
    console,
  };
  context.window.top = context.window;
  runInNewContext(src, context);
  return { frame: context.window.M9RFrame, windowListeners, parent, parentMessages };
}

test("ringOf: a freshly idle agent whose last word was Done gets its own ring, distinct from an agent that simply never started", () => {
  const { ringOf } = load().frame;
  assert.equal(ringOf("idle", "Done"), "done");
  assert.equal(ringOf("idle", "Done (Codex CLI)"), "done", "the persistence suffix after Done still counts");
  assert.equal(ringOf("idle", "Ready"), "idle", "never having run yet is not the same as just finishing");
  assert.equal(ringOf("idle", undefined), "idle");
  assert.equal(ringOf("idle", "Doneness check"), "idle", "must not fire on an unrelated word that merely starts with Done-like text sharing no boundary", );
  assert.equal(ringOf("working", "Done"), "working", "an agent that is working again is not idle, whatever its stale doing text says");
});

test("the extension frame accepts host state only through its nonce-bound message port", () => {
  const fixture = load();
  const seen = [];
  fixture.frame.onHost((data) => seen.push(data));
  const receive = fixture.windowListeners.get("message");

  receive({ source: fixture.parent, data: { m9r: "host", nonce: "test-nonce", kind: "host", vw: 1, vh: 1 }, ports: [] });
  receive({ source: fixture.parent, data: { m9r: "host-port", nonce: "wrong", }, ports: [{ start() {} }] });
  assert.deepEqual(seen, [], "the parent page cannot forge host state or install a port without the frame nonce");

  const port = { onmessage: null, started: false, start() { this.started = true; }, close() {} };
  receive({ source: fixture.parent, data: { m9r: "host-port", nonce: "test-nonce" }, ports: [port] });
  port.onmessage({ data: { m9r: "host", nonce: "test-nonce", kind: "host", vw: 1440, vh: 900 } });
  assert.equal(port.started, true);
  assert.equal(fixture.frame.host.vw, 1440);
  assert.deepEqual(seen.map(({ kind, vw, vh }) => ({ kind, vw, vh })), [{ kind: "host", vw: 1440, vh: 900 }]);

  fixture.frame.toParent({ kind: "size", w: 448, h: 72 });
  assert.equal(fixture.parentMessages[0].data.nonce, "test-nonce");
});

test("a late load can re-authenticate the frame only with the matching parent hello", () => {
  const fixture = load();
  const receive = fixture.windowListeners.get("message");
  receive({ source: {}, data: { m9r: "host-hello", nonce: "test-nonce" } });
  receive({ source: fixture.parent, data: { m9r: "host-hello", nonce: "wrong" } });
  assert.equal(fixture.parentMessages.length, 0);

  receive({ source: fixture.parent, data: { m9r: "host-hello", nonce: "test-nonce" } });
  assert.equal(fixture.parentMessages.length, 1);
  assert.equal(fixture.parentMessages[0].data.kind, "ready");
  assert.equal(fixture.parentMessages[0].data.nonce, "test-nonce");
});
