import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const background = readFileSync(new URL("../extensions/browser/src/background.js", import.meta.url), "utf8");
const nativeInputClient = readFileSync(new URL("../extensions/browser/src/native-input-client.js", import.meta.url), "utf8");

function createHarness(settings: { completeOnCreate?: boolean; autoNativeProgress?: boolean } = {}) {
  const session: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; url: string; status: string }>();
  const created: number[] = [];
  const updated: number[] = [];
  const replies: Array<Record<string, unknown>> = [];
  const pageMessages: Array<Record<string, unknown>> = [];
  const eventOrder: Array<{ kind: "page" | "native"; message: Record<string, unknown> }> = [];
  const nativeInputMessages: Array<Record<string, unknown>> = [];
  const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void; readyState: number; send(payload: string): void; close(): void; receive(payload: Record<string, unknown>): void }> = [];
  const nativePorts: Array<{ emit(message: Record<string, unknown>): void; disconnectCalls(): number }> = [];
  const listeners = new Set<(tabId: number, info: { status?: string }) => void>();
  let nextTabId = 1;
  let activeTabId: number | null = null;
  let currentPageUrl = "https://example.test/";
  let currentTarget = createPageTarget();
  let hitTarget = currentTarget;
  let permissionAllowed = true;
  let pointerArrivalHook: (() => void) | null = null;
  let runtimeMessageListener: ((message: Record<string, unknown>, sender: { url?: string }, sendResponse: (response: Record<string, unknown>) => void) => void) | null = null;
  let sessionReads = 0;
  let clearedLoadTimers = 0;
  const loadTimers = new Set<ReturnType<typeof setTimeout>>();
  const workerSetTimeout = (callback: () => void, delay: number) => {
    const timer = globalThis.setTimeout(() => {
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
    constructor() { sockets.push(this); }
    send(payload: string) { replies.push(JSON.parse(payload) as Record<string, unknown>); }
    receive(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() { this.readyState = 3; }
  }

  function connectNative() {
    let onMessage: ((message: Record<string, unknown>) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let disconnected = false;
    let disconnectCount = 0;
    const port = {
      onMessage: { addListener(listener: (message: Record<string, unknown>) => void) { onMessage = listener; } },
      onDisconnect: { addListener(listener: () => void) { onDisconnect = listener; } },
      postMessage(message: Record<string, unknown>) {
        nativeInputMessages.push(message);
        eventOrder.push({ kind: "native", message });
        if (message.type === "click") {
          if (settings.autoNativeProgress !== false) {
            queueMicrotask(() => onMessage?.({ type: "progress", requestId: message.requestId, x: 50, y: 40, phase: "arrived", sequence: 1 }));
          }
        } else if (message.type === "progressAck") {
          queueMicrotask(() => onMessage?.({ type: "result", requestId: message.requestId, ok: true, arrivalSequence: message.sequence }));
        }
      },
      disconnect() {
        disconnectCount++;
        disconnected = true;
        onDisconnect?.();
      },
    };
    nativePorts.push({
      emit(message) { if (!disconnected) onMessage?.(message); },
      disconnectCalls() { return disconnectCount; },
    });
    return port;
  }

  const chrome = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener: typeof runtimeMessageListener) { runtimeMessageListener = listener; } },
      connectNative,
    },
    permissions: { contains: async () => permissionAllowed },
    storage: {
      session: {
        async get(key: string) { sessionReads++; return { [key]: session[key] }; },
        async set(values: Record<string, unknown>) { Object.assign(session, values); },
      },
    },
    scripting: { async executeScript(details: { func?: (...args: unknown[]) => unknown; args?: unknown[] }) {
      return typeof details.func === "function" ? [{ result: details.func(...(details.args ?? [])) }] : [];
    } },
      tabs: {
      onRemoved: { addListener() {} },
      onUpdated: {
        addListener(listener: (tabId: number, info: { status?: string }) => void) { listeners.add(listener); },
        removeListener(listener: (tabId: number, info: { status?: string }) => void) { listeners.delete(listener); },
      },
      async query(query: { active?: boolean; lastFocusedWindow?: boolean; windowId?: number } = {}) {
        const result = [...tabs.values()].map((tab) => ({ ...tab, active: tab.id === activeTabId, windowId: 1 }));
        return result.filter((tab) => (!query.active || tab.active)
          && (!query.lastFocusedWindow || tab.windowId === 1)
          && (query.windowId === undefined || tab.windowId === query.windowId));
      },
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("tab not found");
        return { ...tab, active: tab.id === activeTabId, windowId: 1 };
      },
      async create(options: { url: string }) {
        const tab = { id: nextTabId++, url: options.url, status: settings.completeOnCreate ? "complete" : "loading" };
        tabs.set(tab.id, tab);
        activeTabId = tab.id;
        currentPageUrl = tab.url;
        created.push(tab.id);
        if (settings.completeOnCreate) for (const listener of [...listeners]) listener(tab.id, { status: "complete" });
        return { ...tab };
      },
      async update(id: number, options: { url: string }) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("tab not found");
        tab.url = options.url;
        if (tab.id === activeTabId) currentPageUrl = tab.url;
        tab.status = "loading";
        updated.push(id);
        return { ...tab };
      },
      async sendMessage(_id: number, message: Record<string, unknown>) {
        pageMessages.push(message);
        eventOrder.push({ kind: "page", message });
        if (message.type === "m9r-native-pointer" && message.phase === "arrived") {
          pointerArrivalHook?.();
          return { painted: true };
        }
        return undefined;
      },
    },
    windows: { async getLastFocused() { return { id: 1 }; } },
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
      window: { __m9rPageActionRefMap: new Map() },
      document: {
        querySelector() { return currentTarget; },
        elementFromPoint() { return hitTarget; },
      },
      location: {
        get href() { return currentPageUrl; },
        get origin() { return new URL(currentPageUrl).origin; },
        get pathname() { return new URL(currentPageUrl).pathname; },
      },
      M9RPermissionLogic: {
        normalizeOrigin: (url: string) => { try { return new URL(url).origin; } catch { return null; } },
        permissionPattern: (origin: string) => `${origin}/*`,
        mayActOnUrl: (url: string) => /^https:\/\//.test(url),
        pathWithinGrant: (url: string, pathPrefix: string) => {
          const path = new URL(url).pathname;
          return !pathPrefix || pathPrefix === "/" || path === pathPrefix
            || path.startsWith(pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/");
        },
      },
      m9rPagePower: (action: string) => action === "target"
        ? { ok: true, data: { name: "Demo button", rect: { x: 40, y: 30, width: 20, height: 20 } } }
        : { ok: true, data: {} },
      m9rPageClickPlan: () => ({ ok: true, data: {
        x: 50, y: 40, viewportWidth: 800, viewportHeight: 600, button: "left", clickCount: 1,
        name: "Demo button", rect: { x: 40, y: 30, width: 20, height: 20 },
      } }),
      m9rPageDialogGuard: () => ({ ok: true }),
    };
    // background.js imports this helper in the real MV3 worker before using it.
    // The other imported dependencies are purpose-built harness fakes below.
    runInNewContext(nativeInputClient, context);
    runInNewContext(background, context);
    return context as typeof context & { handle(command: Record<string, unknown>): Promise<void> };
  }

  function finishLoads() {
    for (const [id, tab] of tabs) {
      tab.status = "complete";
      for (const listener of [...listeners]) listener(id, { status: "complete" });
    }
  }

  return {
    created, updated, replies, pageMessages, eventOrder, nativeInputMessages, nativePorts, session, sockets,
    sessionReads: () => sessionReads, clearedLoadTimers: () => clearedLoadTimers, startWorker, finishLoads,
    onPointerArrival(callback: () => void) { pointerArrivalHook = callback; },
    sendRuntimeMessage(message: Record<string, unknown>, senderUrl: string) {
      let response: Record<string, unknown> | undefined;
      runtimeMessageListener?.(message, { url: senderUrl }, (value) => { response = value; });
      return response;
    },
    setLocation(url: string) {
      currentPageUrl = url;
      const tab = [...tabs.values()].find((candidate) => candidate.id === activeTabId);
      if (tab) tab.url = url;
    },
    replaceTarget() { currentTarget = createPageTarget(); hitTarget = currentTarget; },
    coverTarget() { hitTarget = createPageTarget(); },
    setActiveTab(id: number | null) { activeTabId = id; },
    setPermissionAllowed(value: boolean) { permissionAllowed = value; },
  };
}

function createPageTarget(): Record<string, unknown> {
  const target: Record<string, unknown> = { isConnected: true, disabled: false };
  target.contains = (other: unknown) => other === target;
  target.matches = () => false;
  target.getRootNode = () => target;
  target.querySelector = () => null;
  return target;
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
  h.sockets[0].onopen?.();
  await new Promise((resolve) => setTimeout(resolve, 1));
  for (let attempt = 0; attempt < 100 && !h.replies.some((reply) => reply.type === "ready"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(h.replies.some((reply) => reply.type === "ready"), "extension must send ready after restoring local tab state");
  h.sockets[0].receive({ type: "broker-state", stopped: false });
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

test("a native click's live cursor is driven by OS pointer progress without a preliminary target glide", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "native-click-session" };
  await worker.handle({ id: "open-click-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  await worker.handle({
    id: "trusted-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", presence: { ...identity, action: "click", step: "Clicking" },
  });

  const clickAnnouncementIndex = h.eventOrder.findIndex((entry) => entry.kind === "page" && entry.message.type === "presence" && entry.message.action === "click");
  const clickAnnouncement = h.eventOrder[clickAnnouncementIndex]?.message;
  const nativeClickIndex = h.eventOrder.findIndex((entry) => entry.kind === "native" && entry.message.type === "click");
  const firstPointerIndex = h.eventOrder.findIndex((entry) => entry.kind === "page" && entry.message.type === "m9r-native-pointer");
  assert.ok(clickAnnouncementIndex >= 0, "the overlay receives the current action label");
  assert.equal(clickAnnouncement?.target, null, "native pointer motion, not an overlay target glide, must move the visible cursor");
  assert.ok(nativeClickIndex > clickAnnouncementIndex, `the overlay actor is established before native movement begins; order=${JSON.stringify(h.eventOrder)} replies=${JSON.stringify(h.replies)}`);
  assert.ok(firstPointerIndex > nativeClickIndex, "subsequent drawn cursor points follow OS pointer progress");
  assert.ok(h.nativeInputMessages.some((message) => message.type === "progressAck"), "the click waits for visible arrival acknowledgement");
});

test("a trusted click is cancelled when the page redirects during pointer arrival", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "redirect-click" };
  await worker.handle({ id: "open-redirect-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
  h.onPointerArrival(() => h.setLocation("https://example.test/login"));

  await worker.handle({
    id: "redirected-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity,
  });

  assert.equal(h.nativeInputMessages.some((message) => message.type === "progressAck"), false, "a redirected page must not receive the planned click");
  assert.equal(h.nativePorts[0]?.disconnectCalls(), 1, "failed final validation disconnects the native host before mouse-down");
  assert.notEqual(h.replies.find((reply) => reply.id === "redirected-click")?.ok, true);
});

test("a trusted click is cancelled when its target is replaced during pointer arrival", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "replacement-click" };
  await worker.handle({ id: "open-replacement-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
  h.onPointerArrival(() => h.replaceTarget());

  await worker.handle({
    id: "replaced-target-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity,
  });

  assert.equal(h.nativeInputMessages.some((message) => message.type === "progressAck"), false, "a replacement element at the planned point must not be clicked");
  assert.equal(h.nativePorts[0]?.disconnectCalls(), 1, "target replacement cancels the host request");
  assert.notEqual(h.replies.find((reply) => reply.id === "replaced-target-click")?.ok, true);
});

test("a trusted click is cancelled when another element covers the planned point during pointer arrival", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "covered-click" };
  await worker.handle({ id: "open-covered-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
  h.onPointerArrival(() => h.coverTarget());

  await worker.handle({
    id: "covered-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity,
  });

  assert.equal(h.nativeInputMessages.some((message) => message.type === "progressAck"), false, "the final DOM hit test must reject an overlay at the OS pointer");
  assert.equal(h.nativePorts[0]?.disconnectCalls(), 1);
  assert.notEqual(h.replies.find((reply) => reply.id === "covered-click")?.ok, true);
});

test("a trusted click is cancelled if Chrome revokes site permission during pointer arrival", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "revoked-click" };
  await worker.handle({ id: "open-revoked-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
  h.onPointerArrival(() => h.setPermissionAllowed(false));

  await worker.handle({
    id: "revoked-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity,
  });

  assert.equal(h.nativeInputMessages.some((message) => message.type === "progressAck"), false, "revoked site access must block the final acknowledgment");
  assert.equal(h.nativePorts[0]?.disconnectCalls(), 1);
  assert.notEqual(h.replies.find((reply) => reply.id === "revoked-click")?.ok, true);
});

test("a trusted click is cancelled if its tab stops being the active visible tab during pointer arrival", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "inactive-click" };
  await worker.handle({ id: "open-inactive-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
  h.onPointerArrival(() => h.setActiveTab(null));

  await worker.handle({
    id: "inactive-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity,
  });

  assert.equal(h.nativeInputMessages.some((message) => message.type === "progressAck"), false, "a tab switch during cursor travel must cancel the click");
  assert.equal(h.nativePorts[0]?.disconnectCalls(), 1);
  assert.notEqual(h.replies.find((reply) => reply.id === "inactive-click")?.ok, true);
});

test("Stop-All disconnects an active native click while the OS pointer is still moving", async () => {
  const h = createHarness({ completeOnCreate: true, autoNativeProgress: false });
  const worker = h.startWorker();
  h.sockets[0].onopen?.();
  await new Promise((resolve) => setTimeout(resolve, 1));
  for (let attempt = 0; attempt < 100 && !h.replies.some((reply) => reply.type === "ready"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  h.sockets[0].receive({ type: "broker-state", stopped: false });
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "stop-during-move" };
  await worker.handle({ id: "open-moving-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
  const click = worker.handle({
    id: "moving-click", type: "command", action: "click", tab: "shared", selector: "#continue",
    expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity,
  });
  for (let attempt = 0; attempt < 100 && !h.nativeInputMessages.some((message) => message.type === "click"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const requestId = h.nativeInputMessages.find((message) => message.type === "click")?.requestId;
  assert.equal(typeof requestId, "string", "the click should be moving through the native host");
  h.nativePorts[0].emit({ type: "progress", requestId, x: 20, y: 25, phase: "moving", sequence: 1 });

  const stopResponse = h.sendRuntimeMessage({ type: "m9r-owner-stop-all" }, "chrome-extension://test/permission.html?panel=1");
  assert.equal(stopResponse?.ok, true);
  h.nativePorts[0].emit({ type: "progress", requestId, x: 50, y: 40, phase: "arrived", sequence: 2 });
  await click;

  assert.equal(h.nativePorts[0].disconnectCalls(), 1, "Stop-All must close the native connection immediately");
  assert.ok(h.replies.some((reply) => reply.type === "stop-all"), "the panel's Stop-All request still reaches the broker");
  assert.equal(h.nativeInputMessages.some((message) => message.type === "progressAck"), false, "the host cannot cross its mouse-down gate after Stop-All");
  assert.notEqual(h.replies.find((reply) => reply.id === "moving-click")?.ok, true);
});
