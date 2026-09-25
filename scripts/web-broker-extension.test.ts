import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const background = readFileSync(new URL("../extensions/browser/src/background.js", import.meta.url), "utf8");

function createHarness(settings: { completeOnCreate?: boolean } = {}) {
  const session: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; url: string; status: string }>();
  const created: number[] = [];
  const updated: number[] = [];
  const replies: Array<Record<string, unknown>> = [];
  const pageMessages: Array<Record<string, unknown>> = [];
  const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void; readyState: number; send(payload: string): void; close(): void; receive(payload: Record<string, unknown>): void }> = [];
  const listeners = new Set<(tabId: number, info: { status?: string }) => void>();
  let nextTabId = 1;
  let sessionReads = 0;
  let clearedLoadTimers = 0;
  const loadTimers = new Set<ReturnType<typeof setTimeout>>();
  const workerSetTimeout = (callback: () => void, delay: number) => {
    const timer: ReturnType<typeof setTimeout> = globalThis.setTimeout(() => {
      loadTimers.delete(timer);
      callback();
    }, delay === 10_000 ? 50 : delay);
    if (delay === 10_000) loadTimers.add(timer);
    return timer;
  };
  const workerClearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    if (loadTimers.delete(timer)) clearedLoadTimers++;
    globalThis.clearTimeout(timer);
  };

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { sockets.push(this); }
    send(payload: string) { replies.push(JSON.parse(payload) as Record<string, unknown>); }
    receive(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() { this.readyState = 3; }
  }

  const chrome = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener() {} } },
    permissions: { contains: async () => true },
    storage: {
      session: {
        async get(key: string) { sessionReads++; return { [key]: session[key] }; },
        async set(values: Record<string, unknown>) { Object.assign(session, values); },
      },
    },
    scripting: { async executeScript() { return []; } },
      tabs: {
      onRemoved: { addListener() {} },
      onUpdated: {
        addListener(listener: (tabId: number, info: { status?: string }) => void) { listeners.add(listener); },
        removeListener(listener: (tabId: number, info: { status?: string }) => void) { listeners.delete(listener); },
      },
      async query() { return [...tabs.values()].map((tab) => ({ ...tab })); },
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("tab not found");
        return { ...tab };
      },
      async create(options: { url: string }) {
        const tab = { id: nextTabId++, url: options.url, status: settings.completeOnCreate ? "complete" : "loading" };
        tabs.set(tab.id, tab);
        created.push(tab.id);
        if (settings.completeOnCreate) for (const listener of [...listeners]) listener(tab.id, { status: "complete" });
        return { ...tab };
      },
      async update(id: number, options: { url: string }) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("tab not found");
        tab.url = options.url;
        tab.status = "loading";
        updated.push(id);
        return { ...tab };
      },
      async sendMessage(_id: number, message: Record<string, unknown>) { pageMessages.push(message); },
    },
  };

  function startWorker() {
    const context = {
      chrome,
      WebSocket: FakeWebSocket,
      importScripts() {},
      setTimeout: workerSetTimeout,
      clearTimeout: workerClearTimeout,
      URL,
      URLSearchParams,
      M9RPermissionLogic: {
        normalizeOrigin: (url: string) => { try { return new URL(url).origin; } catch { return null; } },
        permissionPattern: (origin: string) => `${origin}/*`,
        mayActOnUrl: (url: string) => /^https:\/\//.test(url),
        pathWithinGrant: () => true,
      },
    };
    runInNewContext(background, context);
    return context as typeof context & { handle(command: Record<string, unknown>): Promise<void> };
  }

  function finishLoads() {
    for (const [id, tab] of tabs) {
      tab.status = "complete";
      for (const listener of [...listeners]) listener(id, { status: "complete" });
    }
  }

  return { created, updated, replies, pageMessages, session, sockets, sessionReads: () => sessionReads, clearedLoadTimers: () => clearedLoadTimers, startWorker, finishLoads };
}

test("the extension sends ready only after restoring its session tab map", async () => {
  const h = createHarness();
  h.startWorker();
  assert.equal(h.replies.length, 0);
  h.sockets[0].onopen?.();
  for (let attempt = 0; attempt < 100 && h.replies.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(h.sessionReads() > 0);
  assert.deepEqual(h.replies[0], { type: "ready" });
});

test("open resolves immediately when navigation completes before the load listener is attached", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  await worker.handle({ id: "fast", type: "command", action: "open", tab: "fast-page", url: "https://example.com/", presence: { agent: "claude", target: null } });
  assert.equal(h.clearedLoadTimers(), 1, "the current tab state is checked instead of waiting for the fallback timeout");
});

test("a named open tab is reused across an extension worker restart on retry", async () => {
  const h = createHarness();
  const command = { id: "first", type: "command", action: "open", tab: "project", url: "https://example.com/", presence: { agent: "claude", target: null } };
  const firstWorker = h.startWorker();
  const first = firstWorker.handle(command);
  for (let attempt = 0; attempt < 100 && h.created.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(h.created.length, 1, "the first open creates one tab");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const retryWorker = h.startWorker();
  const retry = retryWorker.handle({ ...command, id: "retry" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const createsAfterRetry = h.created.length;
  const updatesAfterRetry = h.updated.length;
  h.finishLoads();
  await Promise.all([first, retry]);

  assert.equal(createsAfterRetry, 1, "retry reuses the tab created by the timed-out attempt");
  assert.equal(updatesAfterRetry, 1, "retry navigates the named tab instead of creating a duplicate");
  assert.equal(h.replies.filter((reply) => reply.type === "result").length, 2);
});

test("extension stop-all blocks broker commands until the server reports a fresh running state", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  await new Promise((resolve) => setTimeout(resolve, 1));
  h.sockets[0].receive({ type: "stop-all", owner: "you" });
  assert.equal(h.pageMessages.length, 0, "no page is open to notify yet");
  await worker.handle({ id: "blocked", type: "command", action: "open", tab: "demo", url: "https://example.com/" });
  assert.equal(h.created.length, 0);
  assert.equal(h.replies.at(-1)?.error, "browser actions are stopped by the owner");
  h.sockets[0].receive({ type: "broker-state", stopped: false });
  await worker.handle({ id: "resumed", type: "command", action: "open", tab: "demo", url: "https://example.com/", presence: { agent: "claude", target: null } });
  assert.equal(h.created.length, 1);
  assert.equal(h.replies.at(-1)?.ok, true);
});
