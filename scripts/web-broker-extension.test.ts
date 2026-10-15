import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const background = readFileSync(new URL("../extensions/browser/src/background.js", import.meta.url), "utf8");
const quietInput = readFileSync(new URL("../extensions/browser/src/quiet-input.js", import.meta.url), "utf8");

function createHarness(settings: { completeOnCreate?: boolean; quietModeEnabled?: boolean; debuggerGranted?: boolean; debuggerAttachError?: string } = {}) {
  const session: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; url: string; status: string }>();
  const created: number[] = [];
  const updated: number[] = [];
  const replies: Array<Record<string, unknown>> = [];
  const pageMessages: Array<Record<string, unknown>> = [];
  const eventOrder: Array<{ kind: "page" | "debugger"; message?: Record<string, unknown>; method?: string; tabId?: number; params?: Record<string, unknown> }> = [];
  const debuggerCalls: Array<{ method: string; tabId: number; params?: Record<string, unknown> }> = [];
  const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void; readyState: number; send(payload: string): void; close(): void; receive(payload: Record<string, unknown>): void }> = [];
  const debuggerTabs = new Set<number>();
  const listeners = new Set<(tabId: number, info: { status?: string }) => void>();
  let nextTabId = 1;
  let activeTabId: number | null = null;
  let currentPageUrl = "https://example.test/";
  let currentTarget = createPageTarget();
  let hitTarget = currentTarget;
  let permissionAllowed = true;
  let quietModeEnabled = settings.quietModeEnabled === true;
  let debuggerGranted = settings.debuggerGranted === true;
  let mouseMoveHook: ((tabId: number) => void) | null = null;
  let runtimeMessageListener: ((message: Record<string, unknown>, sender: { url?: string }, sendResponse: (response: Record<string, unknown>) => void) => void) | null = null;
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
    constructor() { sockets.push(this); }
    send(payload: string) { replies.push(JSON.parse(payload) as Record<string, unknown>); }
    receive(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() { this.readyState = 3; }
  }

  const debuggerDetachListeners = new Set<(source: { tabId: number }, reason: string) => void>();

  const chrome = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener: typeof runtimeMessageListener) { runtimeMessageListener = listener; } },
    },
    permissions: { async contains(query: { origins?: string[]; permissions?: string[] }) {
      if (query.permissions?.includes("debugger")) return debuggerGranted;
      return query.origins ? permissionAllowed : true;
    } },
    storage: {
      session: {
        async get(key: string) { sessionReads++; return { [key]: session[key] }; },
        async set(values: Record<string, unknown>) { Object.assign(session, values); },
      },
      local: {
        async get(key: string) { return { [key]: key === "m9rQuietMode" ? quietModeEnabled : undefined }; },
        async set(values: Record<string, unknown>) { if (typeof values.m9rQuietMode === "boolean") quietModeEnabled = values.m9rQuietMode; },
      },
    },
    debugger: {
      onDetach: {
        addListener(listener: (source: { tabId: number }, reason: string) => void) { debuggerDetachListeners.add(listener); },
        removeListener(listener: (source: { tabId: number }, reason: string) => void) { debuggerDetachListeners.delete(listener); },
      },
      async attach(target: { tabId: number }) {
        debuggerCalls.push({ method: "attach", tabId: target.tabId });
        eventOrder.push({ kind: "debugger", method: "attach", tabId: target.tabId });
        if (settings.debuggerAttachError) throw new Error(settings.debuggerAttachError);
        debuggerTabs.add(target.tabId);
      },
      async detach(target: { tabId: number }) {
        debuggerTabs.delete(target.tabId);
        debuggerCalls.push({ method: "detach", tabId: target.tabId });
        eventOrder.push({ kind: "debugger", method: "detach", tabId: target.tabId });
        for (const listener of [...debuggerDetachListeners]) listener(target, "canceled_by_owner");
      },
      async sendCommand(target: { tabId: number }, method: string, params: Record<string, unknown>) {
        debuggerCalls.push({ method, tabId: target.tabId, params });
        eventOrder.push({ kind: "debugger", method, tabId: target.tabId, params });
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") mouseMoveHook?.(target.tabId);
        return {};
      },
      async getTargets() { return [...debuggerTabs].map((tabId) => ({ tabId, attached: true, extensionId: "test-extension" })); },
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
    // The other imported dependencies are purpose-built harness fakes below.
    runInNewContext(quietInput, context);
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
    created, updated, replies, pageMessages, eventOrder, debuggerCalls, session, sockets,
    sessionReads: () => sessionReads, clearedLoadTimers: () => clearedLoadTimers, startWorker, finishLoads,
    onMouseMove(callback: (tabId: number) => void) { mouseMoveHook = callback; },
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
    setDebuggerGranted(value: boolean) { debuggerGranted = value; },
    setQuietMode(value: boolean) { quietModeEnabled = value; },
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

test("the extension has no browser-click route that drives the physical mouse", () => {
  assert.doesNotMatch(background, /M9RNativeInputClient|nativeInput\.click|m9r-native-pointer/);
});

test("browser clicks fail clearly when independent input is disabled and never move the owner mouse", async () => {
  const h = createHarness({ completeOnCreate: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "no-independent-input" };
  await worker.handle({ id: "open-disabled-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  await worker.handle({ id: "disabled-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", presence: identity });

  const result = h.replies.find((reply) => reply.id === "disabled-click");
  assert.equal(result?.ok, false);
  assert.match(String(result?.error), /quiet_input_required.*will not move your physical mouse/);
  assert.equal(h.debuggerCalls.some((call) => call.method.startsWith("Input.")), false, "no browser input is attempted without the explicit permission");
  assert.equal(h.pageMessages.some((message) => message.type === "presence" && message.action === "click"), false, "the overlay does not pretend a blocked click happened");
});

test("browser clicks fail closed if Chrome has not granted debugger permission", async () => {
  const h = createHarness({ completeOnCreate: true, quietModeEnabled: true, debuggerGranted: false });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "debugger-permission-missing" };
  await worker.handle({ id: "open-no-debugger-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  await worker.handle({ id: "no-debugger-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", presence: identity });

  const result = h.replies.find((reply) => reply.id === "no-debugger-click");
  assert.equal(result?.ok, false);
  assert.match(String(result?.error), /quiet_input_required/);
  assert.equal(h.debuggerCalls.some((call) => call.method.startsWith("Input.")), false);
});

test("an enabled browser click uses Chrome input and the labeled page cursor, without native mouse input", async () => {
  const h = createHarness({ completeOnCreate: true, quietModeEnabled: true, debuggerGranted: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "quiet-click-session" };
  await worker.handle({ id: "open-click-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  await worker.handle({ id: "quiet-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", presence: { ...identity, action: "click", step: "Clicking" } });

  const result = h.replies.find((reply) => reply.id === "quiet-click");
  const inputs = h.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
  const clickAnnouncement = h.eventOrder.findIndex((entry) => entry.kind === "page" && entry.message?.type === "presence" && entry.message.action === "click");
  const firstInput = h.eventOrder.findIndex((entry) => entry.kind === "debugger" && entry.method === "Input.dispatchMouseEvent");
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.deepEqual(inputs.map((call) => call.params?.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(clickAnnouncement >= 0, "the page displays the agent action label");
  assert.ok(firstInput > clickAnnouncement, "the page label is established before the click moves");
  assert.equal(inputs.every((call) => call.tabId === h.created[0]), true, "all input is targeted at the named tab");
  assert.equal(h.pageMessages.some((message) => message.type === "m9r-native-pointer"), false);
});

test("target, URL, path, and site-grant changes during cursor travel block the click", async () => {
  const mutations: Array<{ name: string; change(h: ReturnType<typeof createHarness>): void }> = [
    { name: "redirect", change: (h) => h.setLocation("https://example.test/login") },
    { name: "replace target", change: (h) => h.replaceTarget() },
    { name: "cover target", change: (h) => h.coverTarget() },
    { name: "revoke site grant", change: (h) => h.setPermissionAllowed(false) },
  ];

  for (const mutation of mutations) {
    const h = createHarness({ completeOnCreate: true, quietModeEnabled: true, debuggerGranted: true });
    const worker = h.startWorker();
    const identity = { agent: "codex", provider: "codex-cli", sessionId: `quiet-${mutation.name.replace(/\W/g, "-")}` };
    await worker.handle({ id: "open-race-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/checkout", presence: identity });
    h.onMouseMove(() => mutation.change(h));
    await worker.handle({ id: "racing-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", expectPathPrefix: "/checkout", presence: identity });

    assert.equal(h.debuggerCalls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed"), false, `${mutation.name} must cancel before press`);
    assert.equal(h.replies.find((reply) => reply.id === "racing-click")?.ok, false, `${mutation.name} must return a failure`);
  }
});

test("a browser click remains bound to its tab if the owner switches tabs mid-move", async () => {
  const h = createHarness({ completeOnCreate: true, quietModeEnabled: true, debuggerGranted: true });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "tab-bound-click" };
  await worker.handle({ id: "open-tab-bound", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  h.onMouseMove(() => h.setActiveTab(null));
  await worker.handle({ id: "tab-bound-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", presence: identity });

  const targetTabId = h.created[0];
  const presses = h.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed");
  assert.equal(h.replies.find((reply) => reply.id === "tab-bound-click")?.ok, true);
  assert.equal(presses.length, 1);
  assert.equal(presses[0].tabId, targetTabId, "input stays on the exact requested Chrome tab, not the new foreground tab");
});

test("Stop-All cancels a click after cursor movement but before the page receives a press", async () => {
  const h = createHarness({ completeOnCreate: true, quietModeEnabled: true, debuggerGranted: true });
  const worker = h.startWorker();
  h.sockets[0].onopen?.();
  await new Promise((resolve) => setTimeout(resolve, 1));
  for (let attempt = 0; attempt < 100 && !h.replies.some((reply) => reply.type === "ready"); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  h.sockets[0].receive({ type: "broker-state", stopped: false });
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "stop-during-quiet-move" };
  await worker.handle({ id: "open-stop-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  let stopResponse: Record<string, unknown> | undefined;
  h.onMouseMove(() => { stopResponse = h.sendRuntimeMessage({ type: "m9r-owner-stop-all" }, "chrome-extension://test/permission.html?panel=1"); });
  await worker.handle({ id: "stop-during-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", presence: identity });

  assert.equal(stopResponse?.ok, true);
  assert.equal(h.debuggerCalls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed"), false);
  assert.ok(h.debuggerCalls.some((call) => call.method === "detach"), "Stop-All detaches the debugger route");
  assert.equal(h.replies.find((reply) => reply.id === "stop-during-click")?.ok, false);
  assert.ok(h.replies.some((reply) => reply.type === "stop-all"));
});

test("an occupied Chrome debugger produces a clear refusal and never falls back", async () => {
  const h = createHarness({ completeOnCreate: true, quietModeEnabled: true, debuggerGranted: true, debuggerAttachError: "Another debugger is already attached to the tab" });
  const worker = h.startWorker();
  const identity = { agent: "codex", provider: "codex-cli", sessionId: "devtools-open" };
  await worker.handle({ id: "open-devtools-tab", type: "command", action: "open", tab: "shared", url: "https://example.test/", presence: identity });
  await worker.handle({ id: "devtools-click", type: "command", action: "click", tab: "shared", selector: "#continue", expectOrigin: "https://example.test", presence: identity });

  assert.equal(h.replies.find((reply) => reply.id === "devtools-click")?.ok, false);
  assert.match(String(h.replies.find((reply) => reply.id === "devtools-click")?.error), /devtools_open/);
  assert.equal(h.debuggerCalls.some((call) => call.method.startsWith("Input.")), false);
});
