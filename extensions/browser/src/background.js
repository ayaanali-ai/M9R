importScripts("page-actions.js", "powers.js", "permission-logic.js", "pill-bridge.js");

const BROKER_URL = "ws://127.0.0.1:47821/ext";
const BROKER_AUTH_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 10000;
const NAMED_TABS_STORAGE_KEY = "m9rNamedTabs";
const M9R_GROUP_PREFIX = "M9R: ";
const tabsByName = new Map();
const namedTabOperations = new Map();
let namedTabsLoad = null;
let socket = null;
let brokerAuthenticated = false;
let brokerAuthTimeout = null;
let actionsStopped = false;
const permissionQueue = [];
const promptingGrants = new Set();

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const connection = new WebSocket(BROKER_URL);
  socket = connection;
  brokerAuthenticated = false;
  let readySent = false;
  connection.onopen = () => {
    void loadNamedTabs().then(() => {
      if (socket === connection && connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ type: "ready" }));
        readySent = true;
        brokerAuthTimeout = setTimeout(() => {
          if (socket === connection && !brokerAuthenticated && connection.readyState === WebSocket.OPEN) {
            connection.close(4001, "broker readiness handshake timed out");
          }
        }, BROKER_AUTH_TIMEOUT_MS);
      }
    }).catch(() => connection.close(1011, "named tab state is unavailable"));
  };
  connection.onmessage = (event) => {
    if (socket !== connection) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    // The broker sends this only after accepting the extension-origin connection and its ready frame. A raw open
    // socket (or a process merely listening on the configured port) is not enough to advertise broker readiness.
    if (message && message.type === "broker-state") {
      if (!readySent || typeof message.stopped !== "boolean" || connection.readyState !== WebSocket.OPEN) return;
      if (!brokerAuthenticated) {
        brokerAuthenticated = true;
        if (brokerAuthTimeout !== null) clearTimeout(brokerAuthTimeout);
        brokerAuthTimeout = null;
        if (typeof M9RPillBridge !== "undefined") M9RPillBridge.brokerOpen();
      }
      actionsStopped = message.stopped;
      void chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) if (Number.isSafeInteger(tab.id)) {
          chrome.tabs.sendMessage(tab.id, { type: actionsStopped ? "owner-stop" : "owner-resume", owner: "you" }).catch(() => {});
        }
      });
      return;
    }
    if (!brokerAuthenticated) return;

    if (message && message.type === "command") void handle(message);
    else if (message && message.type === "grant-approved") void queueGrantPermission(message.grant);
    else if (message && message.type === "ui-state") { if (typeof M9RPillBridge !== "undefined") M9RPillBridge.state(message); }
    else if (message && message.type === "stop-all") {
      actionsStopped = true;
      void chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) if (Number.isSafeInteger(tab.id)) {
          chrome.tabs.sendMessage(tab.id, { type: "owner-stop", owner: message.owner }).catch(() => {});
        }
      });
    }
    else if (message && message.type === "notice" && message.presence) {
      const tabId = tabsByName.get(message.tab);
      if (tabId !== undefined) announce(tabId, message.presence, message.presence.target && message.presence.target.selector);
    }
  };
  connection.onclose = () => {
    if (socket === connection) {
      socket = null;
      brokerAuthenticated = false;
      if (brokerAuthTimeout !== null) clearTimeout(brokerAuthTimeout);
      brokerAuthTimeout = null;
      if (typeof M9RPillBridge !== "undefined") M9RPillBridge.brokerClosed();
      setTimeout(connect, 2000);
    }
  };
  connection.onerror = () => connection.close();
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function originNow(tabId) {
  try {
    return originOf((await chrome.tabs.get(tabId)).url);
  } catch {
    return null;
  }
}

async function urlNow(tabId) {
  try {
    const url = (await chrome.tabs.get(tabId)).url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

function pathWithinGrant(url, prefix) {
  return M9RPermissionLogic.pathWithinGrant(url, prefix);
}

async function hasHostPermission(url, expectedOrigin, pathPrefix) {
  const origin = M9RPermissionLogic.normalizeOrigin(url);
  const pattern = origin && M9RPermissionLogic.permissionPattern(origin);
  if (!pattern || (expectedOrigin && origin !== expectedOrigin)) return false;
  try {
    const granted = await chrome.permissions.contains({ origins: [pattern] });
    return granted && M9RPermissionLogic.mayActOnUrl(url, expectedOrigin || null, [pattern], pathPrefix);
  } catch {
    return false;
  }
}

function providerGroupColor(provider) {
  const name = String(provider || "").toLowerCase();
  if (name.includes("claude")) return "orange";
  if (name.includes("codex")) return "green";
  if (name.includes("opencode")) return "purple";
  if (name.includes("grok") || name.includes("xai")) return "blue";
  return "grey";
}

function providerGroupLabel(provider) {
  const name = String(provider || "agent").toLowerCase();
  if (name.includes("claude")) return "Claude";
  if (name.includes("codex")) return "Codex";
  if (name.includes("opencode")) return "OpenCode";
  if (name.includes("grok") || name.includes("xai")) return "Grok";
  return name.slice(0, 32);
}

function agentGroupTitle(presence) {
  const agent = String(presence && presence.agent || "Agent").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64) || "Agent";
  return `${M9R_GROUP_PREFIX}${agent} · ${providerGroupLabel(presence && presence.provider)}`.slice(0, 100);
}

async function groupAgentTab(tab, presence) {
  if (!chrome.tabGroups || typeof chrome.tabs.group !== "function" || !Number.isSafeInteger(tab && tab.id)) return null;
  const title = agentGroupTitle(presence);
  const color = providerGroupColor(presence.provider);
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing = groups.find((group) => group.title === title);
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.id } : {}) });
    await chrome.tabGroups.update(groupId, { title, color });
    return { id: groupId, title, color };
  } catch {
    // Tab grouping is a dev-only convenience; a grouping failure never prevents the browser action itself.
    return null;
  }
}

async function listM9rTabGroups() {
  if (!chrome.tabGroups || typeof chrome.tabGroups.query !== "function") return [];
  try {
    const [groups, browserTabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
    const namesById = new Map();
    for (const [name, tabId] of tabsByName) {
      const choices = namesById.get(tabId) || [];
      choices.push(name);
      namesById.set(tabId, choices);
    }
    return groups.filter((group) => typeof group.title === "string" && group.title.startsWith(M9R_GROUP_PREFIX)).map((group) => ({
      id: group.id,
      title: group.title,
      color: group.color,
      tabs: browserTabs.filter((tab) => tab.groupId === group.id).map((tab) => ({
        name: (namesById.get(tab.id) || []).sort((a, b) => a.length - b.length)[0] || null,
        active: tab.active === true,
      })),
    }));
  } catch {
    return [];
  }
}

function queueGrantPermission(value) {
  const grant = M9RPermissionLogic.normalizeApprovedGrant(value);
  if (!grant || promptingGrants.has(grant.grantId) || permissionQueue.some((item) => item.grantId === grant.grantId)) return;
  promptingGrants.add(grant.grantId);
  permissionQueue.push(grant);
  void showNextPermissionPrompt();
}

async function showNextPermissionPrompt() {
  const grant = permissionQueue[0];
  if (!grant) return;
  const pattern = M9RPermissionLogic.permissionPattern(grant.origin);
  try {
    if (pattern && await chrome.permissions.contains({ origins: [pattern] })) {
      await reportPermissionResult(grant, true);
      return;
    }
    const query = new URLSearchParams({ grantId: grant.grantId, origin: grant.origin, pathPrefix: grant.pathPrefix, actions: grant.actions.join(",") });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`permission.html?${query.toString()}`), active: true });
  } catch {
    // Leave the grant unusable; every action re-checks the browser permission below.
  }
}

async function reportPermissionResult(grant, granted) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "permission-result", grantId: grant.grantId, origin: grant.origin, granted }));
  const index = permissionQueue.findIndex((item) => item.grantId === grant.grantId);
  if (index >= 0) permissionQueue.splice(index, 1);
  promptingGrants.delete(grant.grantId);
  await showNextPermissionPrompt();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "m9r-owner-stop-all") {
    if ((sender.url || "").split("?")[0] !== chrome.runtime.getURL("permission.html")) {
      sendResponse({ ok: false, error: "stop-all is only available from the extension panel" });
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "the local M9R broker is not connected" });
      return;
    }
    socket.send(JSON.stringify({ type: "stop-all" }));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "m9r-message-visibility") {
    if (!sender.tab || typeof message.sessionId !== "string" || message.sessionId.length > 128 || typeof message.show !== "boolean") return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "message-visibility", sessionId: message.sessionId, show: message.show }));
    }
    return;
  }
  if (message.type !== "m9r-permission-result") return;
  const grant = permissionQueue.find((item) => item.grantId === message.grantId && item.origin === message.origin);
  if (grant && typeof message.granted === "boolean") void reportPermissionResult(grant, message.granted);
});

async function ensurePresenceOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/presence-logic.js", "src/dock-logic.js", "src/presence-overlay.js", "src/content.js"] });
  } catch {
    // The page may have navigated or the user may have revoked its host access.
  }
}

function reply(id, result, origin, url) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "result", id, ok: result.ok, data: result.data, error: result.error, label: typeof result.label === "string" ? result.label.slice(0, 80) : undefined, origin: origin || undefined, url: url || undefined }));
}

function announce(tabId, presence, selector, rect) {
  const target = selector || rect ? { selector: selector || null, rect: rect || null } : null;
  // Resolves when the page has finished gliding the agent's cursor to the target (or on failure), so callers can act after it lands.
  return ensurePresenceOverlay(tabId)
    .then(() => chrome.tabs.sendMessage(tabId, { type: "presence", ...presence, target }).catch(() => null))
    .catch(() => null);
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    // The tab can finish between tabs.create/update resolving and listener registration.
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch(done);
  });
}

function loadNamedTabs() {
  if (!namedTabsLoad) {
    namedTabsLoad = chrome.storage.session.get(NAMED_TABS_STORAGE_KEY).then((stored) => {
      const saved = stored && stored[NAMED_TABS_STORAGE_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [name, id] of Object.entries(saved)) {
          if (/^[a-z0-9][a-z0-9_./-]{0,199}$/i.test(name) && Number.isSafeInteger(id)) tabsByName.set(name, id);
        }
      }
      return tabsByName;
    }).catch((error) => {
      namedTabsLoad = null;
      throw error;
    });
  }
  return namedTabsLoad;
}

async function saveNamedTabs() {
  await chrome.storage.session.set({ [NAMED_TABS_STORAGE_KEY]: Object.fromEntries(tabsByName) });
}

async function forgetNamedTab(name) {
  await loadNamedTabs();
  tabsByName.delete(name);
  await saveNamedTabs();
}

async function withNamedTabLock(name, operation) {
  const previous = namedTabOperations.get(name) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  namedTabOperations.set(name, current);
  try {
    return await current;
  } finally {
    if (namedTabOperations.get(name) === current) namedTabOperations.delete(name);
  }
}

// Background tabs do not animate, so an agent working in one looks frozen. Bring the tab the agent acts in to the front
// (throttled so several agents do not make the window flicker), unless the owner turned "follow the agents" off.
let lastFollowAt = 0;
async function followAgent(tabId) {
  try {
    const { m9rFollow } = await chrome.storage.local.get("m9rFollow");
    if (m9rFollow === false) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return;
    if (Date.now() - lastFollowAt < 2500) return;
    lastFollowAt = Date.now();
    await chrome.tabs.update(tabId, { active: true });
  } catch { /* the tab may have closed */ }
}

async function existingTab(name) {
  await loadNamedTabs();
  const id = tabsByName.get(name);
  if (id === undefined) return null;
  try {
    return await chrome.tabs.get(id);
  } catch {
    await forgetNamedTab(name);
    return null;
  }
}

// A link that opens a new tab (target=_blank, window.open) from an M9R tab becomes an M9R tab too, owned by the same agent,
// so the agent can see it in m9r_web_tabs and keep working in it instead of losing the page it just opened.
if (chrome.tabs.onCreated && typeof chrome.tabs.onCreated.addListener === "function") chrome.tabs.onCreated.addListener((created) => {
  if (!created || typeof created.openerTabId !== "number") return;
  void loadNamedTabs().then(async () => {
    const parent = [...tabsByName].find(([, id]) => id === created.openerTabId);
    if (!parent) return;
    let name = `${parent[0]}-new`.slice(0, 36);
    for (let n = 2; tabsByName.has(name); n += 1) name = `${parent[0].slice(0, 32)}-new${n}`;
    tabsByName.set(name, created.id);
    await saveNamedTabs();
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "tab-opened", tab: name, parent: parent[0], url: String(created.pendingUrl || created.url || "") }));
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void loadNamedTabs().then(async () => {
    const removed = [...tabsByName].filter(([, id]) => id === tabId).map(([name]) => name);
    for (const name of removed) {
      tabsByName.delete(name);
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "tab-closed", tab: name }));
    }
    if (removed.length) await saveNamedTabs();
  }).catch(() => {});
});

async function run(tabId, func, args, retried, retryNavigation = true) {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return injection.result || { ok: false, error: "the page returned nothing" };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    // No site permission yet (or it was revoked): ask the owner in the pill, then try once more.
    if (!retried && /cannot access contents|missing host permission|extension manifest must request permission/i.test(message)) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const allowed = globalThis.M9RPillBridge && globalThis.M9RPillBridge.requestConsent && /^https?:/.test(tab.url || "")
          ? await globalThis.M9RPillBridge.requestConsent(tab.url, null) : false;
        if (allowed) return run(tabId, func, args, true);
      } catch { /* fall through to the plain error */ }
      return { ok: false, error: "M9R cannot run on this page: the owner has not allowed this site (or it is a browser page). Tell the owner which site you need; do not conclude M9R only works on localhost. Detail: " + message.slice(0, 160) };
    }
    // A page that is still loading or redirecting refuses injection for a moment: wait and try again before reporting.
    if (retryNavigation && (retried || 0) < 2 && /frame with id|was removed|error page|no tab with id|cannot be scripted|before the page|loading/i.test(message + " ")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return run(tabId, func, args, (retried || 0) + 1, retryNavigation);
    }
    return { ok: false, error: "the browser could not run that on this page: " + message.slice(0, 200) };
  }
}

async function handle(command) {
  try {
    if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" });
    if (command.action === "tabs") {
      const tabs = [...tabsByName].map(([name, id]) => ({ name, id }));
      return reply(command.id, { ok: true, data: { tabs, groups: await listM9rTabGroups() } });
    }
    if (command.action === "adopt") {
      // The owner said yes through the approval queue. The agent joins the page the owner is on, in place: nothing is opened or reloaded.
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const known = active ? [...tabsByName].find(([, id]) => id === active.id) : null;
      if (!active || !/^https?:\/\//.test(String(active.url || ""))) return reply(command.id, { ok: false, error: "The owner is not on a web page right now, so there is nothing to join. Ask them to open the page, or use m9r_web_open." });
      if (!await hasHostPermission(active.url, command.expectOrigin || null, command.expectPathPrefix)) {
        const allowed = globalThis.M9RPillBridge && globalThis.M9RPillBridge.requestConsent ? await globalThis.M9RPillBridge.requestConsent(active.url, command.presence) : false;
        if (!allowed || !await hasHostPermission(active.url, command.expectOrigin || null, command.expectPathPrefix)) return reply(command.id, { ok: false, error: "The owner has not allowed M9R on this site yet." });
      }
      await loadNamedTabs();
      tabsByName.set(command.tab, active.id);
      await saveNamedTabs();
      await followAgent(active.id);
      announce(active.id, command.presence, null, null);
      return reply(command.id, { ok: true, data: { tab: command.tab, url: active.url, note: known ? "That page was already an M9R tab; you now share it." : "You are now working in the page the owner is on. Take a snapshot first." } }, originOf(active.url), active.url);
    }
    if (command.action === "open") {
      if (!await hasHostPermission(command.url, command.expectOrigin || null, command.expectPathPrefix)) {
        // Not allowed yet: ask the owner right here (a card in the M9R pill) instead of failing, and wait for the answer.
        const allowed = globalThis.M9RPillBridge && globalThis.M9RPillBridge.requestConsent ? await globalThis.M9RPillBridge.requestConsent(command.url, command.presence) : false;
        if (!allowed || !await hasHostPermission(command.url, command.expectOrigin || null, command.expectPathPrefix)) return reply(command.id, { ok: false, error: "The owner has not allowed M9R on this site yet, so it cannot be opened. Do not try other sites blindly: tell the owner which site you need (they can allow it from the M9R toolbar panel) and keep working with sites you can already open" });
      }
      if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" });
      return await withNamedTabLock(command.tab, async () => {
        if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" });
        const tab = await existingTab(command.tab);
        const opened = tab ? await chrome.tabs.update(tab.id, { url: command.url }) : await chrome.tabs.create({ url: command.url, active: true });
        await loadNamedTabs();
        tabsByName.set(command.tab, opened.id);
        await saveNamedTabs();
        await waitForLoad(opened.id);
        const actualUrl = await urlNow(opened.id);
        const landed = originOf(actualUrl);
        if (command.expectOrigin && landed !== command.expectOrigin) {
          await chrome.tabs.update(opened.id, { url: "about:blank" });
          return reply(command.id, { ok: false, error: "the page ended up outside the granted site" }, null);
        }
        if (command.expectPathPrefix && !pathWithinGrant(actualUrl, command.expectPathPrefix)) {
          await chrome.tabs.update(opened.id, { url: "about:blank" });
          return reply(command.id, { ok: false, error: "the page ended up outside the granted path" }, landed, actualUrl);
        }
        await groupAgentTab(opened, command.presence);
        await followAgent(opened.id);
        const openedTarget = typeof m9rPagePower === "function"
          ? await run(opened.id, m9rPagePower, ["target", null, {}, command.expectOrigin || null, command.expectPathPrefix || null])
          : null;
        announce(opened.id, command.presence, null, openedTarget && openedTarget.ok && openedTarget.data ? openedTarget.data.rect : null);
        return reply(command.id, { ok: true, data: { tab: command.tab, url: command.url } }, landed, actualUrl);
      });
    }

    const tab = await existingTab(command.tab);
    if (!tab) return reply(command.id, { ok: false, error: 'tab "' + command.tab + '" is not open; call m9r_web_open first' });
    const current = originOf(tab.url);
    if (!await hasHostPermission(tab.url, command.expectOrigin || null, command.expectPathPrefix)) return reply(command.id, { ok: false, error: "M9R has no Chrome permission for this site or granted path" }, current, tab.url);
    if (command.expectOrigin && current !== command.expectOrigin) {
      return reply(command.id, { ok: false, error: "the tab is no longer on the granted site" }, current);
    }
    if (command.expectPathPrefix && !pathWithinGrant(tab.url, command.expectPathPrefix)) {
      return reply(command.id, { ok: false, error: "the tab is no longer within the granted path" }, current, tab.url);
    }
    if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" }, current, tab.url);
    if (command.action !== "read") await followAgent(tab.id);
    // Like a person: scroll the target into view smoothly, let the cursor travel to it, pause a beat, then act.
    const humanLike = !!command.selector && !["read", "scroll", "snapshot", "find", "wait", "extract"].includes(command.action);
    if (humanLike && typeof m9rPageMine === "function") await run(tab.id, m9rPageMine, ["ensure_visible", command.selector, {}, command.expectOrigin || null, command.expectPathPrefix || null]);
    const targetAction = command.action === "click_at" ? "target_at" : "target";
    const targetInfo = await run(tab.id, m9rPagePower, [targetAction, command.selector || null, command.args || {}, command.expectOrigin || null, command.expectPathPrefix || null]);
    // Sites such as X swap the search box for a new element once it is used. A key press aimed at a ref that has gone stale goes
    // to whatever is focused (the field the agent just typed in) instead of failing.
    if (command.action === "press" && command.selector && targetInfo && !targetInfo.ok && /stale|no element matches/.test(String(targetInfo.error || ""))) command = { ...command, selector: null };
    const targetRect = targetInfo && targetInfo.ok && targetInfo.data ? targetInfo.data.rect || null : null;
    const actionPresence = command.action === "point"
      ? { ...command.presence, action: "Pointing at this one", message: "Pointing at this one" }
      : command.presence;
    const liveSelector = command.selector && !String(command.selector).startsWith("@m9r-ref:")
      ? command.selector
      : targetInfo && targetInfo.ok && targetInfo.data ? targetInfo.data.selector || null : null;
    const arrival = announce(tab.id, actionPresence, liveSelector, targetRect);
    if (humanLike) await Promise.race([arrival, new Promise((resolve) => setTimeout(resolve, 1000))]);

    let preLabel = targetInfo && targetInfo.ok && targetInfo.data && typeof targetInfo.data.name === "string" ? targetInfo.data.name : null;
    if (command.selector && typeof m9rPageLabel === "function") {
      const named = await run(tab.id, m9rPageLabel, [command.selector]);
      if (named && named.ok && named.data) preLabel = named.data;
    }
    const pressBefore = command.action === "press" && typeof m9rPageMine === "function"
      ? await run(tab.id, m9rPageMine, ["page_state", null, {}, null, null])
      : null;
    if (humanLike) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: m9rPageDialogGuard, args: [false] }).catch(() => null);
    let result;
    if (command.action === "read") result = await run(tab.id, m9rPageRead, [command.selector || null, command.expectOrigin || null, command.expectPathPrefix || null]);
    else if (command.action === "click") result = await run(tab.id, m9rPageClick, [command.selector, command.expectOrigin || null, command.expectPathPrefix || null, true]);
    else if (command.action === "type") result = await run(tab.id, m9rPageType, [command.selector, command.text, command.expectOrigin || null, command.expectPathPrefix || null, true]);
    else if (command.action === "snapshot") {
      result = await run(tab.id, m9rPageSnapshot, [(command.args && command.args.query) || null, (command.args && command.args.limit) || null]);
      if (result && result.ok && typeof m9rPageMine === "function") await run(tab.id, m9rPageMine, ["heal", null, {}, null, null]);
    }
    else if (command.action === "press" && typeof m9rPageMine === "function") {
      // A key can navigate the page, destroying its execution context. Never
      // replay Enter in that case; inspect the landed page instead.
      result = await run(tab.id, m9rPageMine, ["press", command.selector || null, command.args || {}, command.expectOrigin || null, command.expectPathPrefix || null], 0, false);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await waitForLoad(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const pressAfter = await run(tab.id, m9rPageMine, ["page_state", null, {}, null, null]);
      const before = pressBefore && pressBefore.ok && pressBefore.data ? pressBefore.data : {};
      const after = pressAfter && pressAfter.ok && pressAfter.data ? pressAfter.data : {};
      const pageChanged = (typeof before.url === "string" && typeof after.url === "string" && before.url !== after.url)
        || (typeof before.visibleText === "string" && typeof after.visibleText === "string" && before.visibleText !== after.visibleText);
      if (result && result.ok) {
        const data = result.data && typeof result.data === "object" ? result.data : {};
        result.data = {
          ...data,
          pageChanged,
          ...(pageChanged ? {} : { hint: `Nothing visibly changed after ${String(command.args && command.args.key || "the key")}; check the page before retrying.` }),
        };
      } else if (pageChanged) {
        result = { ok: true, data: { pressed: String(command.args && command.args.key || "the key"), effect: "page changed while the key was being processed", pageChanged: true } };
      }
    }
    else if (command.action === "back" || command.action === "forward" || command.action === "reload") {
      const urlBefore = await urlNow(tab.id);
      if (command.action === "back" || command.action === "forward") {
        const step = command.action === "back" ? chrome.tabs.goBack : chrome.tabs.goForward;
        let moved = true;
        await step.call(chrome.tabs, tab.id).catch(() => { moved = false; });
        // goBack/goForward can refuse silently on some tabs; the page's own history does the same thing.
        if (!moved) await run(tab.id, (direction) => { direction === "back" ? history.back() : history.forward(); return { ok: true }; }, [command.action]);
      } else await chrome.tabs.reload(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await waitForLoad(tab.id);
      const urlAfter = await urlNow(tab.id);
      result = (command.action === "back" || command.action === "forward") && urlAfter === urlBefore
        ? { ok: false, error: `There is no ${command.action === "back" ? "earlier" : "later"} page in this tab's history.` }
        : { ok: true, data: { url: urlAfter, title: (await chrome.tabs.get(tab.id)).title } };
    } else if (command.action === "switch") {
      if (tab.groupId >= 0 && chrome.tabGroups && typeof chrome.tabGroups.update === "function") {
        await chrome.tabGroups.update(tab.groupId, { collapsed: false });
      }
      await chrome.tabs.update(tab.id, { active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
      result = { ok: true, data: { switchedTo: command.tab, url: tab.url } };
    } else if (command.action === "close") {
      await chrome.tabs.remove(tab.id);
      await loadNamedTabs();
      tabsByName.delete(command.tab);
      await saveNamedTabs();
      result = { ok: true, data: { closed: command.tab } };
    } else if (command.action === "screenshot") {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        const format = command.args && command.args.format === "png" ? "png" : "jpeg";
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality: 55 });
        result = { ok: true, data: { mimeType: "image/" + format, data: String(dataUrl).split(",")[1] || "" } };
      } catch (error) {
        const text = String(error && error.message ? error.message : error);
        result = { ok: false, error: /all_urls|activeTab/.test(text) ? "Screenshots need the owner's permission for all websites (M9R panel: Allow all websites). Meanwhile use m9r_web_snapshot or m9r_web_read to see the page." : text };
      }
    } else if (typeof m9rPagePower === "function") {
      result = await run(tab.id, m9rPagePower, [command.action, command.selector || null, command.args || {}, command.expectOrigin || null, command.expectPathPrefix || null]);
    } else result = { ok: false, error: "unknown action " + command.action };
    if (humanLike && result && result.ok) {
      const dialogs = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: m9rPageDialogGuard, args: [true] }).then((r) => (r && r[0] && Array.isArray(r[0].result) ? r[0].result : [])).catch(() => []);
      if (dialogs.length && result.data && typeof result.data === "object" && !Array.isArray(result.data)) result.data = { ...result.data, dialogs, note: "The page opened a native dialog. M9R answered it safely (alert closed, confirm no, prompt cancelled); ask the owner if it needed a different answer." };
    }
    if (preLabel && result && result.ok && !result.label) result.label = preLabel;
    return reply(command.id, result, await originNow(tab.id), await urlNow(tab.id));
  } catch (error) {
    return reply(command.id, { ok: false, error: String(error && error.message ? error.message : error) });
  }
}

if (typeof M9RPillBridge !== "undefined") {
  M9RPillBridge.init({
    send(payload) {
      if (!brokerAuthenticated || !socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(payload));
      return true;
    },
    connected: () => brokerAuthenticated && !!socket && socket.readyState === WebSocket.OPEN,
  });
}

chrome.alarms.create("m9r-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  connect();
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
});

connect();
