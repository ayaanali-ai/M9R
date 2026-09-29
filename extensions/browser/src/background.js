importScripts("page-actions.js", "powers.js", "permission-logic.js", "pill-bridge.js", "native-input-client.js");

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
const nativeInput = M9RNativeInputClient.create(chrome.runtime);

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
      if (actionsStopped) nativeInput.close();
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
    else if (message && message.type === "ui-state") {
      if (typeof M9RPillBridge !== "undefined") M9RPillBridge.state(message);
      // The cursor overlay never got a live roster before, so it only knew an agent was still around by recent cursor
      // movement -- an agent quietly waiting on a teammate (the normal, encouraged state now) went stale after 90s and
      // faded out even though it never stopped. This is what "I saw Codex, then it was gone" was: the room felt like
      // one agent at a time instead of two people present on the same page, because presence was tied to activity
      // instead of membership. A real roster fixes that: an agent's cursor now stays until it is truly gone.
      if (Array.isArray(message.agents)) {
        const agents = message.agents.map((a) => ({ id: a.id, state: a.state }));
        void chrome.tabs.query({}).then((tabs) => {
          for (const tab of tabs) if (Number.isSafeInteger(tab.id)) chrome.tabs.sendMessage(tab.id, { type: "m9r-agents", agents }).catch(() => {});
        });
      }
    }
    else if (message && message.type === "stop-all") {
      actionsStopped = true;
      nativeInput.close();
      void chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) if (Number.isSafeInteger(tab.id)) {
          chrome.tabs.sendMessage(tab.id, { type: "owner-stop", owner: message.owner }).catch(() => {});
        }
      });
    }
    else if (message && message.type === "notice" && message.presence) {
      const tabId = tabsByName.get(message.tab);
      if (typeof message.noticeId === "string") {
        const presence = message.presence;
        const acknowledge = (rendered) => {
          if (socket !== connection || connection.readyState !== WebSocket.OPEN) return;
          try {
            connection.send(JSON.stringify({
              type: "notice-ack",
              noticeId: message.noticeId,
              tab: message.tab,
              agent: presence.agent,
              provider: presence.provider,
              sessionId: presence.sessionId,
              rendered: rendered === true,
            }));
          } catch { /* a disconnect is reported as an unacknowledged Done notice */ }
        };
        if (tabId === undefined) acknowledge(false);
        else void announce(tabId, presence, presence.target && presence.target.selector).then((response) => acknowledge(response?.rendered === true));
      } else if (tabId !== undefined) {
        announce(tabId, message.presence, message.presence.target && message.presence.target.selector);
      }
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

// Every agent that has acted in a tab, so the group title reads "M9R · Codex + OpenCode" once a second agent joins the
// shared page, instead of freezing on whoever opened it first.
const groupAgentsByTab = new Map();

function agentGroupTitle(tabId, presence) {
  const agent = String(presence && presence.agent || "Agent").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 32) || "Agent";
  const seen = groupAgentsByTab.get(tabId) || new Set();
  seen.add(agent);
  groupAgentsByTab.set(tabId, seen);
  const names = seen.size === 1 ? `${agent} · ${providerGroupLabel(presence && presence.provider)}` : [...seen].join(" + ");
  return `${M9R_GROUP_PREFIX}${names}`.slice(0, 100);
}

async function groupAgentTab(tab, presence) {
  if (!chrome.tabGroups || typeof chrome.tabs.group !== "function" || !Number.isSafeInteger(tab && tab.id)) return null;
  const title = agentGroupTitle(tab.id, presence);
  const color = providerGroupColor(presence.provider);
  try {
    // A tab already in an M9R group keeps that same group and is only renamed (a teammate joining must never spawn a
    // second group for the same tab, which a title-text lookup would do the moment the title changes to include them).
    // A tab that is in some OTHER group -- one the owner made themselves, unrelated to M9R -- must never be retitled or
    // recolored; only a group M9R itself created and named is ever reused.
    let groupId;
    if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
      const current = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (current && typeof current.title === "string" && current.title.startsWith(M9R_GROUP_PREFIX)) groupId = tab.groupId;
    }
    // A fresh tab looks for another tab already grouped under this single agent's own name, so its tabs share one group.
    if (groupId === undefined) {
      const soloTitle = `${M9R_GROUP_PREFIX}${String(presence.agent || "Agent").slice(0, 32)} · ${providerGroupLabel(presence.provider)}`;
      const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
      groupId = groups.find((group) => group.title === soloTitle || group.title === title)?.id;
    }
    groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(groupId !== undefined ? { groupId } : {}) });
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
    await reportPermissionResult(grant, !!pattern && await chrome.permissions.contains({ origins: [pattern] }));
  } catch {
    await reportPermissionResult(grant, false);
  }
}

async function reportPermissionResult(grant, granted) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "permission-result", grantId: grant.grantId, origin: grant.origin, granted }));
  const index = permissionQueue.findIndex((item) => item.grantId === grant.grantId);
  if (index >= 0) permissionQueue.splice(index, 1);
  promptingGrants.delete(grant.grantId);
  await showNextPermissionPrompt();
}

// The pill is drawn in CSS pixels, which Chrome's per-site zoom scales; every page learns its tab's zoom so it can scale the pill back.
if (chrome.tabs && chrome.tabs.onZoomChange) {
  chrome.tabs.onZoomChange.addListener((info) => {
    try { chrome.tabs.sendMessage(info.tabId, { type: "m9r-zoom", zoom: info.newZoomFactor }).catch(() => {}); } catch { /* the tab has no M9R page */ }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "m9r-get-zoom") {
    if (!sender.tab || !chrome.tabs.getZoom) { sendResponse({ zoom: 1 }); return; }
    chrome.tabs.getZoom(sender.tab.id).then((zoom) => sendResponse({ zoom }), () => sendResponse({ zoom: 1 }));
    return true;
  }
  if (message.type === "m9r-owner-stop-all") {
    if ((sender.url || "").split("?")[0] !== chrome.runtime.getURL("permission.html")) {
      sendResponse({ ok: false, error: "stop-all is only available from the extension panel" });
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "the local M9R broker is not connected" });
      return;
    }
    actionsStopped = true;
    nativeInput.close();
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

const injectedTabs = new Set();
const presenceInjectionOperations = new Map();

function ensurePresenceOverlay(tabId) {
  if (injectedTabs.has(tabId)) return Promise.resolve();
  const previous = presenceInjectionOperations.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (injectedTabs.has(tabId)) return;
    injectedTabs.add(tabId);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/presence-logic.js", "src/dock-logic.js", "src/presence-overlay.js", "src/content.js"] });
    } catch (error) {
      injectedTabs.delete(tabId);
      throw error;
    }
  });
  presenceInjectionOperations.set(tabId, current);
  return current.finally(() => {
    if (presenceInjectionOperations.get(tabId) === current) presenceInjectionOperations.delete(tabId);
  });
}

if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => { injectedTabs.clear(); });

function reply(id, result, origin, url) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "result", id, ok: result.ok, data: result.data, error: result.error, label: typeof result.label === "string" ? result.label.slice(0, 80) : undefined, origin: origin || undefined, url: url || undefined }));
}

function announce(tabId, presence, selector, rect, point) {
  const target = selector || rect || point ? { selector: selector || null, rect: rect || null, ...(point ? { point } : {}) } : null;
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
    namedTabsLoad = chrome.storage.session.get(NAMED_TABS_STORAGE_KEY).then(async (stored) => {
      const saved = stored && stored[NAMED_TABS_STORAGE_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        const entries = Object.entries(saved);
        const valid = entries.filter(([name, id]) => /^[a-z0-9][a-z0-9_./-]{0,199}$/i.test(name) && Number.isSafeInteger(id));
        // A damaged/stale session map must not make two names point at one
        // physical tab. Preserve the contract's canonical "shared" name;
        // otherwise pick a stable lexical winner so every worker restart
        // reconstructs the same room map.
        valid.sort((a, b) => Number(a[0] !== "shared") - Number(b[0] !== "shared") || a[0].localeCompare(b[0]));
        const seenTabIds = new Set();
        for (const [name, id] of valid) {
          if (seenTabIds.has(id)) continue;
          seenTabIds.add(id);
          tabsByName.set(name, id);
        }
        if (valid.length !== entries.length || tabsByName.size !== valid.length) {
          await chrome.storage.session.set({ [NAMED_TABS_STORAGE_KEY]: Object.fromEntries(tabsByName) });
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

// A page navigation (the agent following a link, or the owner clicking one) destroys the isolated-world JS context that
// held the notch, and nothing re-creates it until the NEXT unrelated action happens to call announce(). In between, the
// notch is genuinely gone -- visible as "the side notch disappeared on a page, came back on the next page." Re-inject
// proactively the moment a tracked tab finishes loading its new document, instead of waiting on the next action.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Loading means the old document (and its notch) is gone. Clear the marker
  // before the complete event so the next document is always reinjected.
  if (info.status === "loading" || typeof info.url === "string") injectedTabs.delete(tabId);
  if (info.status !== "complete") return;
  void loadNamedTabs().then(() => {
    if ([...tabsByName.values()].includes(tabId)) return ensurePresenceOverlay(tabId);
    return undefined;
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  groupAgentsByTab.delete(tabId);
  injectedTabs.delete(tabId);
  presenceInjectionOperations.delete(tabId);
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
    // Chrome site access may have been withheld or revoked. Do not retry through an M9R site prompt.
    if (!retried && /cannot access contents|missing host permission|extension manifest must request permission/i.test(message)) {
      return { ok: false, error: "M9R cannot run on this page. Check Chrome's extension site-access setting, or use a normal HTTP/HTTPS page. Detail: " + message.slice(0, 160) };
    }
    // A page that is still loading or redirecting refuses injection for a moment: wait and try again before reporting.
    if (retryNavigation && (retried || 0) < 2 && /frame with id|was removed|error page|no tab with id|cannot be scripted|before the page|loading/i.test(message + " ")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return run(tabId, func, args, (retried || 0) + 1, retryNavigation);
    }
    return { ok: false, error: "the browser could not run that on this page: " + message.slice(0, 200) };
  }
}

// Keep the planned DOM element alive in the extension's isolated page world
// while the OS pointer travels. At arrival, require that exact element to
// remain selected and to be under the actual visible pointer coordinates.
function m9rPageNativeClickTarget(selector, action, planX, planY, pointerX, pointerY, requestId, phase, expectOrigin, expectPathPrefix, expectedUrl) {
  const storeKey = "__m9rNativeClickTargetRefs";
  try {
    let targets = window[storeKey];
    if (phase === "clear") {
      if (targets && typeof targets.delete === "function") targets.delete(requestId);
      return { ok: true };
    }
    const inGrantedPath = !expectPathPrefix || expectPathPrefix === "/" || location.pathname === expectPathPrefix
      || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/");
    if ((expectOrigin && location.origin !== expectOrigin) || !inGrantedPath) {
      return { ok: false, error: "page origin or path changed before the trusted click" };
    }
    if (expectedUrl && location.href !== expectedUrl) {
      return { ok: false, error: "page URL changed after the click was planned" };
    }

    if (!targets && phase === "capture") {
      targets = new Map();
      Object.defineProperty(window, storeKey, { value: targets, configurable: false });
    }
    if (!targets || typeof targets.get !== "function" || typeof targets.set !== "function") {
      return { ok: false, error: "the planned page target identity is unavailable" };
    }
    if (phase === "capture" && typeof targets.clear === "function") targets.clear();

    let target = null;
    if (action === "click_at") {
      target = document.elementFromPoint(planX, planY);
    } else if (typeof selector === "string" && selector.startsWith("@m9r-ref:")) {
      const match = /^@m9r-ref:([A-Za-z0-9_-]{1,16})$/.exec(selector);
      const refs = window.__m9rPageActionRefMap;
      target = match && refs
        ? typeof refs.get === "function" ? refs.get(match[1])
          : Object.prototype.hasOwnProperty.call(refs, match[1]) ? refs[match[1]] : null
        : null;
    } else if (typeof selector === "string") {
      target = document.querySelector(selector);
    }
    if (action === "submit" && target && String(target.tagName || "").toUpperCase() === "FORM") {
      target = target.querySelector('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]');
    }
    if (!target || target.isConnected === false) return { ok: false, error: "the planned page target was replaced or removed" };

    const pointReachesTarget = (x, y) => {
      if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return false;
      const hit = document.elementFromPoint(Number(x), Number(y));
      let reaches = !!hit && (hit === target || target.contains(hit));
      for (let root = target.getRootNode && target.getRootNode(); !reaches && root && root.host; root = root.host.getRootNode && root.host.getRootNode()) {
        reaches = hit === root.host || !!hit && root.host.contains(hit);
      }
      return reaches;
    };

    if (phase === "capture") {
      if (!pointReachesTarget(planX, planY)) return { ok: false, error: "the planned point no longer hits its target" };
      targets.set(requestId, target);
      return { ok: true };
    }
    if (phase !== "validate") return { ok: false, error: "invalid trusted-click target validation phase" };
    const plannedTarget = targets.get(requestId);
    if (!plannedTarget || plannedTarget !== target) {
      return { ok: false, error: "the planned page target changed during pointer movement" };
    }
    if (!pointReachesTarget(pointerX, pointerY)) {
      return { ok: false, error: "the visible OS pointer is no longer over the planned page target" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: "could not verify the trusted-click target: " + String(error && error.message || error).slice(0, 160) };
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
      await loadNamedTabs();
      const known = active ? [...tabsByName].find(([, id]) => id === active.id) : null;
      if (!active || !/^https?:\/\//.test(String(active.url || ""))) return reply(command.id, { ok: false, error: "The owner is not on a web page right now, so there is nothing to join. Ask them to open the page, or use m9r_web_open." });
      if (!await hasHostPermission(active.url, command.expectOrigin || null, command.expectPathPrefix)) {
        return reply(command.id, { ok: false, error: "M9R cannot access this site. Check Chrome's extension site-access setting and the agent's grant scope." });
      }
      if (!known) {
        if (tabsByName.has(command.tab)) return reply(command.id, { ok: false, error: `tab name "${command.tab}" already refers to another page` });
        tabsByName.set(command.tab, active.id);
        await saveNamedTabs();
      }
      await followAgent(active.id);
      announce(active.id, command.presence, null, null);
      return reply(command.id, { ok: true, data: { tab: known ? known[0] : command.tab, url: active.url, note: known ? "That page was already an M9R tab; you now share it." : "You are now working in the page the owner is on. Take a snapshot first." } }, originOf(active.url), active.url);
    }
    if (command.action === "open") {
      if (!await hasHostPermission(command.url, command.expectOrigin || null, command.expectPathPrefix)) {
        return reply(command.id, { ok: false, error: "M9R cannot access this site. Check Chrome's extension site-access setting and the agent's grant scope." });
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
    // A teammate acting in a tab someone else opened joins its group too, so the group title shows everyone working there.
    // Only real page work counts; merely switching to look, closing or taking a screenshot does not add a name.
    // Fire-and-forget: grouping is a dev-only convenience, and awaiting chrome.tabGroups here added a round trip ahead of
    // every click that could run long enough to blow the broker's response timeout on some pages (iframe-focused tabs,
    // double/right clicks). The action itself must never wait on it.
    if (command.presence && command.presence.agent && !["switch", "close", "screenshot"].includes(command.action)) void groupAgentTab(tab, command.presence);
    if (command.action !== "read") await followAgent(tab.id);
    // Actions that already validate and scroll their target do not pay for a
    // separate ensure_visible injection first.
    const humanLike = !!command.selector && !["read", "scroll", "snapshot", "find", "wait", "extract"].includes(command.action);
    const actionScrollsTarget = ["click", "click_at", "type", "double_click", "right_click", "download", "submit", "buy", "post", "follow", "like", "dm", "select", "check", "uncheck", "toggle", "fill_form"].includes(command.action);
    if (humanLike && !actionScrollsTarget && typeof m9rPageMine === "function") await run(tab.id, m9rPageMine, ["ensure_visible", command.selector, {}, command.expectOrigin || null, command.expectPathPrefix || null]);
    const targetAction = command.action === "click_at" ? "target_at" : "target";
    const targetInfo = await run(tab.id, m9rPagePower, [targetAction, command.selector || null, command.args || {}, command.expectOrigin || null, command.expectPathPrefix || null]);
    const nativeClickAction = ["click", "click_at", "double_click", "right_click", "download", "submit", "buy", "post", "follow", "like", "dm"].includes(command.action);
    let nativeClickPlan = null;
    let nativeClickPlanUrl = null;
    if (nativeClickAction) {
      const button = command.action === "right_click" ? "right"
        : command.action === "click_at" && ["right", "middle"].includes(command.args && command.args.button) ? command.args.button
          : "left";
      const beforePlanTab = await chrome.tabs.get(tab.id);
      nativeClickPlanUrl = beforePlanTab.url || null;
      nativeClickPlan = await run(tab.id, m9rPageClickPlan, [
        command.selector || null,
        command.expectOrigin || null,
        command.expectPathPrefix || null,
        command.action === "click_at" ? Number(command.args && command.args.x) : null,
        command.action === "click_at" ? Number(command.args && command.args.y) : null,
        button,
        command.action === "double_click" ? 2 : 1,
        command.action,
      ]);
      if (nativeClickPlan && nativeClickPlan.ok) {
        const afterPlanTab = await chrome.tabs.get(tab.id);
        if (!nativeClickPlanUrl || afterPlanTab.url !== nativeClickPlanUrl) {
          nativeClickPlan = { ok: false, error: "page URL changed while preparing the trusted click" };
        }
      }
    }
    // Sites such as X swap the search box for a new element once it is used. A key press aimed at a ref that has gone stale goes
    // to whatever is focused (the field the agent just typed in) instead of failing.
    if (command.action === "press" && command.selector && targetInfo && !targetInfo.ok && /stale|no element matches/.test(String(targetInfo.error || ""))) command = { ...command, selector: null };
    const targetRect = nativeClickPlan && nativeClickPlan.ok && nativeClickPlan.data
      ? nativeClickPlan.data.rect
      : targetInfo && targetInfo.ok && targetInfo.data ? targetInfo.data.rect || null : null;
    const actionPresence = command.action === "point"
      ? { ...command.presence, action: "Pointing at this one", message: "Pointing at this one" }
      : command.presence;
    const liveSelector = command.selector && !String(command.selector).startsWith("@m9r-ref:")
      ? command.selector
      : targetInfo && targetInfo.ok && targetInfo.data ? targetInfo.data.selector || null : null;
    const nativePointerDrivesCursor = nativeClickAction && !!(nativeClickPlan && nativeClickPlan.ok && nativeClickPlan.data);
    const arrival = announce(
      tab.id,
      actionPresence,
      nativePointerDrivesCursor ? null : liveSelector,
      nativePointerDrivesCursor ? null : targetRect,
      nativePointerDrivesCursor ? null : nativeClickPlan && nativeClickPlan.ok && nativeClickPlan.data
        ? { x: nativeClickPlan.data.x, y: nativeClickPlan.data.y }
        : null,
    );
    // A target glide and native OS movement must never race each other. Establish the action label first, then let
    // native pointer progress be the sole source of cursor movement for trusted clicks.
    if (nativePointerDrivesCursor) await arrival;
    else if (humanLike) await Promise.race([arrival, new Promise((resolve) => setTimeout(resolve, 1000))]);

    let preLabel = targetInfo && targetInfo.ok && targetInfo.data && typeof targetInfo.data.name === "string" ? targetInfo.data.name : null;
    // m9rPagePower already returns the accessible target name. A second label
    // injection here only repeated the same DOM lookup before every action.
    const pressBefore = command.action === "press" && typeof m9rPageMine === "function"
      ? await run(tab.id, m9rPageMine, ["page_state", null, {}, null, null])
      : null;
    if (humanLike) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: m9rPageDialogGuard, args: [false] }).catch(() => null);
    let result;
    if (command.action === "read") result = await run(tab.id, m9rPageRead, [command.selector || null, command.expectOrigin || null, command.expectPathPrefix || null]);
    else if (nativeClickAction) {
      const plan = nativeClickPlan;
      if (!plan || !plan.ok || !plan.data) result = plan || { ok: false, error: "could not prepare the trusted click" };
      else {
        const currentTab = await chrome.tabs.get(tab.id);
        if (actionsStopped) {
          result = { ok: false, error: "browser actions are stopped by the owner" };
        } else if (currentTab.url !== nativeClickPlanUrl
          || !await hasHostPermission(currentTab.url, command.expectOrigin || null, command.expectPathPrefix)) {
          result = { ok: false, error: "page permission or grant changed before the trusted click" };
        } else {
          const focusedWindow = await chrome.windows.getLastFocused();
          const activeTabs = await chrome.tabs.query({ active: true, windowId: focusedWindow.id });
          if (!activeTabs.some((active) => active.id === tab.id)) {
            result = { ok: false, error: "the shared tab is no longer the visible active Chrome tab; no click was sent" };
          } else {
            const requestId = `m9r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
            const capturedTarget = await run(tab.id, m9rPageNativeClickTarget, [
              command.selector || null, command.action, plan.data.x, plan.data.y, null, null,
              requestId, "capture", command.expectOrigin || null, command.expectPathPrefix || null, nativeClickPlanUrl,
            ], 0, false);
            if (!capturedTarget || !capturedTarget.ok) {
              result = { ok: false, error: capturedTarget && capturedTarget.error || "could not capture the planned click target" };
            } else if (actionsStopped) {
              await run(tab.id, m9rPageNativeClickTarget, [
                command.selector || null, command.action, plan.data.x, plan.data.y, null, null,
                requestId, "clear", command.expectOrigin || null, command.expectPathPrefix || null, nativeClickPlanUrl,
              ], 0, false);
              result = { ok: false, error: "browser actions are stopped by the owner" };
            } else {
              try {
                await nativeInput.click({
                  requestId,
                  x: plan.data.x,
                  y: plan.data.y,
                  viewportWidth: plan.data.viewportWidth,
                  viewportHeight: plan.data.viewportHeight,
                  button: plan.data.button,
                  clickCount: plan.data.clickCount,
                }, (progress) => chrome.tabs.sendMessage(tab.id, {
                  type: "m9r-native-pointer",
                  agent: String(command.presence && command.presence.agent || "").slice(0, 64),
                  x: progress.x,
                  y: progress.y,
                  phase: progress.phase,
                  active: true,
                }), {
                  beforeMouseDown: async (progress) => {
                    if (actionsStopped) throw new Error("browser actions are stopped by the owner");
                    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                    if (!activeTab || activeTab.id !== tab.id) throw new Error("the planned tab is no longer the visible active tab");
                    if (activeTab.url !== nativeClickPlanUrl) throw new Error("the tab URL changed after the click was planned");
                    if (!await hasHostPermission(activeTab.url, command.expectOrigin || null, command.expectPathPrefix)) {
                      throw new Error("page permission or grant changed before mouse-down");
                    }
                    const [stillActiveTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                    if (!stillActiveTab || stillActiveTab.id !== tab.id || stillActiveTab.url !== nativeClickPlanUrl) {
                      throw new Error("the active tab or URL changed during final click validation");
                    }
                    if (actionsStopped) throw new Error("browser actions are stopped by the owner");
                    const verified = await run(tab.id, m9rPageNativeClickTarget, [
                      command.selector || null, command.action, plan.data.x, plan.data.y, progress.x, progress.y,
                      requestId, "validate", command.expectOrigin || null, command.expectPathPrefix || null, nativeClickPlanUrl,
                    ], 0, false);
                    if (!verified || !verified.ok) throw new Error(verified && verified.error || "the planned click target changed");
                    if (actionsStopped) throw new Error("browser actions are stopped by the owner");
                    return true;
                  },
                });
              } finally {
                await run(tab.id, m9rPageNativeClickTarget, [
                  command.selector || null, command.action, plan.data.x, plan.data.y, null, null,
                  requestId, "clear", command.expectOrigin || null, command.expectPathPrefix || null, nativeClickPlanUrl,
                ], 0, false);
                await chrome.tabs.sendMessage(tab.id, {
                  type: "m9r-native-pointer",
                  agent: String(command.presence && command.presence.agent || "").slice(0, 64),
                  x: plan.data.x,
                  y: plan.data.y,
                  active: false,
                }).catch(() => {});
              }
              result = { ok: true, data: { clicked: true, trustedInput: "native-desktop", target: plan.data.name, rect: plan.data.rect } };
            }
          }
        }
      }
    }
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
        result = { ok: false, error: /all_urls|activeTab/.test(text) ? "Chrome has withheld screenshot access for this tab. Check the extension's site-access setting, or use m9r_web_snapshot or m9r_web_read to inspect the page." : text };
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
