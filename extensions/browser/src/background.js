importScripts("page-actions.js", "permission-logic.js");

const BROKER_URL = "ws://127.0.0.1:47821/ext";
const LOAD_TIMEOUT_MS = 10000;
const NAMED_TABS_STORAGE_KEY = "m9rNamedTabs";
const tabsByName = new Map();
const namedTabOperations = new Map();
let namedTabsLoad = null;
let socket = null;
let actionsStopped = false;
const permissionQueue = [];
const promptingGrants = new Set();

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const connection = new WebSocket(BROKER_URL);
  socket = connection;
  connection.onopen = () => {
    void loadNamedTabs().then(() => {
      if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "ready" }));
    }).catch(() => connection.close(1011, "named tab state is unavailable"));
  };
  connection.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message && message.type === "command") void handle(message);
    else if (message && message.type === "grant-approved") void queueGrantPermission(message.grant);
    else if (message && message.type === "broker-state" && typeof message.stopped === "boolean") {
      actionsStopped = message.stopped;
      void chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) if (Number.isSafeInteger(tab.id)) {
          chrome.tabs.sendMessage(tab.id, { type: actionsStopped ? "owner-stop" : "owner-resume", owner: "you" }).catch(() => {});
        }
      });
    }
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/presence-logic.js", "src/presence-overlay.js", "src/content.js"] });
  } catch {
    // The page may have navigated or the user may have revoked its host access.
  }
}

function reply(id, result, origin, url) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "result", id, ok: result.ok, data: result.data, error: result.error, origin: origin || undefined, url: url || undefined }));
}

function announce(tabId, presence, selector) {
  void ensurePresenceOverlay(tabId).then(() => {
  chrome.tabs
    .sendMessage(tabId, { type: "presence", ...presence, target: selector ? { selector } : presence.target || null })
    .catch(() => {});
  });
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

async function run(tabId, func, args) {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return injection.result || { ok: false, error: "the page returned nothing" };
  } catch (error) {
    return { ok: false, error: "this extension can only act on localhost pages right now (" + (error && error.message ? error.message : error) + ")" };
  }
}

async function handle(command) {
  try {
    if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" });
    if (command.action === "open") {
      if (!await hasHostPermission(command.url, command.expectOrigin || null, command.expectPathPrefix)) return reply(command.id, { ok: false, error: "M9R has no Chrome permission for this site; approve access from the M9R site-consent screen first" });
      if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" });
      return await withNamedTabLock(command.tab, async () => {
        if (actionsStopped) return reply(command.id, { ok: false, error: "browser actions are stopped by the owner" });
        const tab = await existingTab(command.tab);
        const opened = tab ? await chrome.tabs.update(tab.id, { url: command.url }) : await chrome.tabs.create({ url: command.url, active: false });
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
        announce(opened.id, command.presence, null);
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
    announce(tab.id, command.presence, command.selector);

    let result;
    if (command.action === "read") result = await run(tab.id, m9rPageRead, [command.selector || null, command.expectOrigin || null, command.expectPathPrefix || null]);
    else if (command.action === "click") result = await run(tab.id, m9rPageClick, [command.selector, command.expectOrigin || null, command.expectPathPrefix || null]);
    else if (command.action === "type") result = await run(tab.id, m9rPageType, [command.selector, command.text, command.expectOrigin || null, command.expectPathPrefix || null]);
    else result = { ok: false, error: "unknown action " + command.action };
    return reply(command.id, result, await originNow(tab.id), await urlNow(tab.id));
  } catch (error) {
    return reply(command.id, { ok: false, error: String(error && error.message ? error.message : error) });
  }
}

chrome.alarms.create("m9r-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  connect();
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
});

connect();
