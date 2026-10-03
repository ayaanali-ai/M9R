import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/pill-bridge.js", import.meta.url), "utf8");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const BASE = `chrome-extension://${ID}/`;
const NONCE = "0123456789abcdef0123456789abcdef";

function load(opts: { origins?: string[] } = {}) {
  const session: Record<string, unknown> = {};
  const registered: any[] = [];
  const sent: any[] = [];
  const chrome = {
    runtime: { id: ID, getURL: (p: string) => BASE + p, onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    storage: { session: { async get(k: string) { return { [k]: session[k] }; }, async set(v: any) { Object.assign(session, v); } } },
    tabs: { async query() { return []; }, async sendMessage() { return { selection: "" }; }, onActivated: { addListener() {} }, onRemoved: { addListener() {} } },
    permissions: { async getAll() { return { origins: opts.origins || [] }; }, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    scripting: {
      async getRegisteredContentScripts() { return registered.slice(); },
      async registerContentScripts(s: any[]) { registered.push(...s); },
      async updateContentScripts(s: any[]) { registered.splice(0, registered.length, ...s); },
      async unregisterContentScripts() { registered.length = 0; },
      async executeScript() {},
    },
    commands: { onCommand: { addListener() {} } },
  };
  const g: any = { chrome, console, URL, Promise, setTimeout };
  g.self = g;
  runInNewContext(source, g);
  const bridge = g.M9RPillBridge;
  bridge.init({ send: (m: any) => { sent.push(m); return true; }, connected: () => true });
  return { bridge, sent, registered };
}

const pillSender = (over: any = {}) => ({ id: ID, url: `${BASE}pill-next/index.html?n=${NONCE}`, tab: { id: 7, url: "https://example.com/", title: "Example" }, frameId: 0, ...over });
const scriptSender = (over: any = {}) => ({ id: ID, url: "https://example.com/page", tab: { id: 7 }, frameId: 0, ...over });

async function registerNonce(bridge: any) {
  return bridge._internals.onRuntimeMessage({ type: "m9r-pill-register", nonce: NONCE }, scriptSender());
}

test("only this extension's pill frame with a registered nonce is accepted", async () => {
  const { bridge } = load();
  const { isOwnFrame } = bridge._internals;
  assert.equal(await isOwnFrame(pillSender()), false, "nonce not registered yet");
  assert.equal((await registerNonce(bridge)).ok, true);
  assert.equal(await isOwnFrame(pillSender()), true);
  assert.equal(await isOwnFrame(pillSender({ id: "someoneelse" })), false, "other extension");
  assert.equal(await isOwnFrame(pillSender({ url: "https://evil.example/pill-next/index.html?n=" + NONCE })), false, "web page origin");
  assert.equal(await isOwnFrame(pillSender({ url: `${BASE}permission.html?n=${NONCE}` })), false, "other extension page");
  assert.equal(await isOwnFrame(scriptSender()), false, "content script");
  assert.equal(await isOwnFrame(pillSender({ tab: { id: 8 } })), false, "nonce belongs to another tab");
  assert.equal(await isOwnFrame(pillSender({ url: `${BASE}pill-next/index.html?n=ffffffffffffffffffffffffffffffff` })), false, "unknown nonce");
});

test("commands from content scripts and web pages are rejected, from the pill they reach the broker", async () => {
  const { bridge, sent } = load();
  const { onRuntimeMessage } = bridge._internals;
  await registerNonce(bridge);
  const cmd = { type: "m9r-pill-cmd", command: { type: "ui-command", text: "@claude hi" } };
  assert.equal((await onRuntimeMessage(cmd, scriptSender())).ok, false);
  assert.equal((await onRuntimeMessage(cmd, { id: undefined, url: "https://evil.example/", tab: { id: 7 } })).ok, false);
  assert.equal(sent.length, 0);
  assert.equal((await onRuntimeMessage(cmd, pillSender())).ok, true);
  assert.equal(sent[0].type, "ui-command");
  assert.equal(sent[0].text, "@claude hi");
  assert.equal(sent[0].context.url, "https://example.com/");
  for (const command of [{ type: "ui-approve", id: "a1" }, { type: "ui-deny", id: "a1" }, { type: "ui-stop", agent: "claude" }, { type: "ui-stop-all" }]) {
    assert.equal((await onRuntimeMessage({ type: "m9r-pill-cmd", command }, pillSender())).ok, true);
    assert.equal((await onRuntimeMessage({ type: "m9r-pill-cmd", command }, scriptSender())).ok, false);
  }
  assert.deepEqual(sent.slice(1).map((m: any) => m.type), ["ui-approve", "ui-deny", "ui-stop", "ui-stop-all"]);
  assert.equal((await onRuntimeMessage({ type: "m9r-pill-cmd", command: { type: "ui-eval", text: "x" } }, pillSender())).ok, false);
});

test("only the top frame of a web page may register a nonce", async () => {
  const { bridge } = load();
  const { onRuntimeMessage } = bridge._internals;
  const msg = { type: "m9r-pill-register", nonce: NONCE };
  assert.equal((await onRuntimeMessage(msg, pillSender())).ok, false, "extension frame");
  assert.equal((await onRuntimeMessage(msg, scriptSender({ frameId: 3 }))).ok, false, "subframe");
  assert.equal((await onRuntimeMessage(msg, scriptSender({ id: "other" }))).ok, false);
  assert.equal((await onRuntimeMessage({ type: "m9r-pill-register", nonce: "short" }, scriptSender())).ok, false);
  assert.equal((await onRuntimeMessage(msg, scriptSender())).ok, true);
});

test("only a top-frame content script on an ordinary page can register a nonce; extension pages cannot", async () => {
  const { bridge } = load();
  const msg = { type: "m9r-pill-register", nonce: NONCE };
  assert.equal((await bridge._internals.onRuntimeMessage(msg, scriptSender({ url: "https://example.com/" }))).ok, true);
  assert.equal((await bridge._internals.onRuntimeMessage(msg, scriptSender({ url: "https://example.com/", frameId: 1 }))).ok, false);
  assert.equal((await bridge._internals.onRuntimeMessage(msg, scriptSender({ url: `${BASE}newtab.html` }))).ok, false);
  assert.equal((await bridge._internals.onRuntimeMessage(msg, scriptSender({ url: `${BASE}permission.html` }))).ok, false);
});

test("ui-state is sanitized", () => {
  const { bridge } = load();
  const out = bridge._internals.sanitizeState({ agents: [{ id: "c", provider: "claude", state: "nonsense", doing: "x" }, null], thread: [{ id: "1", kind: "say", text: "hi", agent: "c", provider: "claude" }, { id: "2", kind: "bogus", text: "no" }], approvals: [{ id: "a", text: "t" }, { text: "no id" }] });
  assert.equal(out.agents.length, 1);
  assert.equal(out.agents[0].state, "idle");
  assert.equal(out.thread.length, 1);
  assert.equal(out.approvals.length, 1);
});

test("content scripts are registered for granted sites only, never localhost twice", async () => {
  const { bridge, registered } = load({ origins: ["http://localhost/*", "https://en.wikipedia.org/*", "https://github.com/*"] });
  await bridge._internals.syncSiteScripts();
  assert.equal(registered.length, 1);
  assert.deepEqual([...registered[0].matches], ["https://en.wikipedia.org/*", "https://github.com/*"]);
  assert.equal(registered[0].persistAcrossSessions, true);
  const none = load({ origins: ["http://localhost/*"] });
  await none.bridge._internals.syncSiteScripts();
  assert.equal(none.registered.length, 0);
});
