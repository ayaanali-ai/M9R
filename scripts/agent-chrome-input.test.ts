import assert from "node:assert/strict";
import test from "node:test";
import { dragChrome } from "../src/lib/native/agent-chrome-input";
import { createWebBroker } from "../src/lib/native/web-broker-core";

test("broker forwards drag destination and queues typing until drag completes", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const broker = createWebBroker({ send: (raw) => { if ((raw as { type?: string }).type === "command") sent.push(raw as Record<string, unknown>); return true; }, oneWriterPerTab: true, roomMode: () => "watch", timeoutMs: 1000 });
  const base = { agent: "codex", provider: "codex", sessionId: "c2-test", tab: "c2" };
  const drag = broker.submit({ ...base, action: "drag", selector: "#source", endSelector: "#end" });
  const type = broker.submit({ ...base, agent: "claude", provider: "claude", sessionId: "c2-second-writer", action: "type", selector: "#text", text: "queued" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endSelector, "#end");
  broker.onExtensionMessage({ type: "result", id: sent[0].id, ok: true });
  assert.equal((await drag).ok, true);
  await new Promise(done => setImmediate(done));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].action, "type");
  broker.onExtensionMessage({ type: "result", id: sent[1].id, ok: true });
  assert.equal((await type).ok, true);
});

test("pointer drag uses pressed moves and releases without synthetic DOM input", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let unsubscribed = false;
  await dragChrome({ send: async (method, params) => { calls.push({ method, params }); }, check: async () => {}, onDrag: () => () => { unsubscribed = true; } }, { x: 10, y: 20 }, { x: 100, y: 200 });
  assert.equal(calls.filter(c => c.params.type === "mouseMoved" && c.params.buttons === 1).length, 12);
  assert.equal(calls.at(-2)?.params.type, "mouseReleased");
  assert.deepEqual(calls.at(-1), { method: "Input.setInterceptDrags", params: { enabled: false } });
  assert.equal(unsubscribed, true);
});

test("native HTML drag data is dispatched through Chrome, never exposed as a result", async () => {
  const calls: string[] = [];
  let listener: (data: Record<string, unknown>) => void = () => {};
  await dragChrome({ send: async (method, params) => { calls.push(String(params.type ?? method)); if (params.type === "mousePressed") listener({ items: [{ mimeType: "text/plain", data: "fixture" }], dragOperationsMask: 1 }); }, check: async () => {}, onDrag: (fn) => { listener = fn; return () => {}; } }, { x: 1, y: 1 }, { x: 2, y: 2 });
  assert.deepEqual(calls.filter(c => ["dragEnter", "dragOver", "drop"].includes(c)), ["dragEnter", "dragOver", "drop"]);
});

test("revocation during a drag cancels and releases the button", async () => {
  const calls: string[] = [];
  let checks = 0;
  await assert.rejects(dragChrome({ send: async (method, params) => { calls.push(String(params.type ?? method)); }, check: async () => { if (++checks === 4) throw new Error("revoked"); }, onDrag: () => () => {} }, { x: 1, y: 1 }, { x: 2, y: 2 }), /revoked/);
  assert.ok(calls.includes("Input.cancelDragging"));
  assert.ok(calls.includes("mouseReleased"));
  assert.equal(calls.at(-1), "Input.setInterceptDrags");
});
