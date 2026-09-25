const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const background = readFileSync(
  require("node:path").join(__dirname, "../extensions/browser/src/background.js"),
  "utf8",
);

function createHarness() {
  const session = {};
  const tabs = new Map();
  const groups = new Map();
  const sockets = [];
  let nextTabId = 1;
  let nextGroupId = 1;

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.readyState = 3;
    }
  }

  const chrome = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: {
      getURL: (path) => `chrome-extension://m9r/${path}`,
      onMessage: { addListener() {} },
    },
    permissions: { contains: async () => true },
    storage: {
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(values) { Object.assign(session, values); },
      },
      local: { async get() { return {}; } },
    },
    scripting: { async executeScript() { return []; } },
    tabGroups: {
      async query(filter = {}) {
        return [...groups.values()]
          .filter((group) => filter.windowId === undefined || group.windowId === filter.windowId)
          .map((group) => ({ ...group }));
      },
      async update(groupId, changes) {
        const group = groups.get(groupId);
        if (!group) throw new Error("group not found");
        Object.assign(group, changes);
        return { ...group };
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
      async query() { return [...tabs.values()].map((tab) => ({ ...tab })); },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("tab not found");
        return { ...tab };
      },
      async create({ url, active = false }) {
        const tab = { id: nextTabId++, windowId: 1, url, active, status: "complete", groupId: -1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId, changes) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("tab not found");
        Object.assign(tab, changes);
        return { ...tab };
      },
      async group({ tabIds, groupId }) {
        let targetGroupId = groupId;
        if (targetGroupId === undefined) {
          targetGroupId = nextGroupId++;
          groups.set(targetGroupId, { id: targetGroupId, windowId: 1, title: "", color: "grey" });
        }
        for (const tabId of tabIds) {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error("tab not found");
          tab.groupId = targetGroupId;
        }
        return targetGroupId;
      },
      async sendMessage() {},
    },
  };

  const context = {
    chrome,
    m9rPagePower() { return { ok: true, data: { rect: { x: 0, y: 0, width: 800, height: 600 } } }; },
    WebSocket: FakeWebSocket,
    importScripts() {},
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Date,
    M9RPermissionLogic: {
      normalizeOrigin(url) {
        try { return new URL(url).origin; } catch { return null; }
      },
      permissionPattern(origin) { return `${origin}/*`; },
      mayActOnUrl(url) { return /^https?:\/\//.test(url); },
      pathWithinGrant() { return true; },
    },
  };

  runInNewContext(background, context);
  runInNewContext(
    "globalThis.__testApi = { handle, listM9rTabGroups, tabsByName };",
    context,
  );

  return { context, groups, sockets, tabs };
}

async function openAgentTab(worker, tab, presence) {
  await worker.handle({
    id: `open-${tab}`,
    action: "open",
    tab,
    url: "https://example.com/",
    presence: { agent: presence.agent, provider: presence.provider, target: null },
  });
}

test("created tabs join an agent group titled and colored for their provider", async () => {
  const h = createHarness();
  const worker = h.context.__testApi;

  await openAgentTab(worker, "claude-main", { agent: "claude-main", provider: "claude-code" });
  await openAgentTab(worker, "claude-research", { agent: "claude-main", provider: "claude-code" });
  await openAgentTab(worker, "codex-main", { agent: "codex-main", provider: "codex-cli" });
  await openAgentTab(worker, "opencode-main", { agent: "opencode-main", provider: "opencode" });

  assert.equal(h.tabs.size, 4);
  assert.equal(h.groups.size, 3, "tabs for the same agent reuse its provider group");
  assert.deepEqual(
    [...h.groups.values()].map(({ title, color }) => ({ title, color })),
    [
      { title: "M9R: claude-main · Claude", color: "orange" },
      { title: "M9R: codex-main · Codex", color: "green" },
      { title: "M9R: opencode-main · OpenCode", color: "purple" },
    ],
  );

  const claudeGroupId = [...h.groups.values()].find((group) => group.title.includes("claude-main"))?.id;
  assert.equal([...h.tabs.values()].filter((tab) => tab.groupId === claudeGroupId).length, 2);
});

test("group listing returns each agent group and its named tabs", async () => {
  const h = createHarness();
  const worker = h.context.__testApi;

  await openAgentTab(worker, "claude-work", { agent: "claude", provider: "claude-code" });
  await openAgentTab(worker, "codex-work", { agent: "codex", provider: "codex-cli" });

  const listed = await worker.listM9rTabGroups();
  assert.deepEqual(
    JSON.parse(JSON.stringify(listed)),
    [
      {
        id: 1,
        title: "M9R: claude · Claude",
        color: "orange",
        tabs: [{ name: "claude-work", active: true }],
      },
      {
        id: 2,
        title: "M9R: codex · Codex",
        color: "green",
        tabs: [{ name: "codex-work", active: true }],
      },
    ],
  );
});

test("agents can list and switch to another agent's named tab group", async () => {
  const h = createHarness();
  const worker = h.context.__testApi;
  await openAgentTab(worker, "claude-work", { agent: "claude", provider: "claude-code" });
  await openAgentTab(worker, "codex-work", { agent: "codex", provider: "codex-cli" });

  let response;
  h.sockets.at(-1).readyState = 1;
  await worker.handle({ id: "list", action: "tabs" });
  response = h.sockets.at(-1).sent.find((message) => message.type === "result" && message.id === "list");
  assert.equal(response?.ok, true);
  assert.equal(response?.data.groups.length, 2);

  await worker.handle({ id: "switch", action: "switch", tab: "codex-work", presence: { agent: "claude", provider: "claude-code" } });
  response = h.sockets.at(-1).sent.find((message) => message.type === "result" && message.id === "switch");
  assert.equal(response?.ok, true, JSON.stringify(response));
  const codexGroup = [...h.groups.values()].find((group) => group.title.startsWith("M9R: codex"));
  const codexTab = [...h.tabs.values()].find((tab) => tab.groupId === codexGroup?.id);
  assert.equal(codexGroup?.collapsed, false);
  assert.equal(codexTab?.active, true);
});
