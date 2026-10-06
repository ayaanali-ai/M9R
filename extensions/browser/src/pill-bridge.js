// Service-worker side of the in-page pill and message bar. Loaded by background.js with importScripts.
//
// Trust rules:
// - Owner commands are accepted only from this extension's own pill.html / composer.html frames, and only when the
//   frame carries a nonce that M9R's content script registered for that same tab. A page cannot register one (it cannot
//   message the extension), so a page that embeds pill.html itself gets a frame that can do nothing.
// - ui-state goes only to validated frames, and the thread text never passes through the page's own world.
(function (global) {
  "use strict";

  const FRAME_PAGES = ["pill-next/index.html"];
  const NONCE_KEY = "m9rPillNonces";
  const SITE_SCRIPT_ID = "m9r-granted-sites";
  const CONTENT_JS = ["src/presence-logic.js", "src/dock-logic.js", "src/presence-overlay.js", "src/content.js"];
  const LOCAL_ORIGINS = ["http://localhost/*", "http://127.0.0.1/*"];
  const AGENT_STATES = new Set(["idle", "starting", "working", "waiting", "blocked", "stopped", "failed"]);
  const THREAD_KINDS = new Set(["say", "do", "block", "approval", "system"]);
  const MAX_NONCES_PER_TAB = 6;

  let sendToBroker = () => false;
  let brokerConnected = () => false;
  let lastState = null;
  function currentState() {
    return lastState || { type: "ui-state", agents: [], thread: [], approvals: [] };
  }
  const ports = new Set();
  let noncesLoad = null;
  const noncesByTab = new Map();

  const str = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

  function sanitizeState(message) {
    const agents = (Array.isArray(message.agents) ? message.agents : []).slice(0, 24).flatMap((a) => {
      if (!a || typeof a.id !== "string" || !a.id) return [];
      return [{ id: str(a.id, 64), provider: str(a.provider, 40), folder: str(a.folder, 400), state: AGENT_STATES.has(a.state) ? a.state : "idle", doing: str(a.doing, 400) }];
    });
    const thread = (Array.isArray(message.thread) ? message.thread : []).slice(-300).flatMap((t) => {
      if (!t || typeof t.id !== "string" || !THREAD_KINDS.has(t.kind) || typeof t.text !== "string") return [];
      const item = { id: str(t.id, 128), at: str(t.at, 40), kind: t.kind, agent: str(t.agent, 64), provider: str(t.provider, 40), text: str(t.text, 8000) };
      if (typeof t.to === "string" && t.to) item.to = str(t.to, 200);
      if (t.phase === "start" || t.phase === "done") item.phase = t.phase;
      if (typeof t.ok === "boolean") item.ok = t.ok;
      for (const key of ["site", "url", "tab", "target"]) if (typeof t[key] === "string" && t[key]) item[key] = str(t[key], 400);
      return [item];
    });
    const approvals = (Array.isArray(message.approvals) ? message.approvals : []).slice(0, 50).flatMap((p) => {
      if (!p || typeof p.id !== "string" || typeof p.text !== "string") return [];
      const item = { id: str(p.id, 128), agent: str(p.agent, 64), provider: str(p.provider, 40), text: str(p.text, 4000) };
      for (const key of ["site", "url", "action", "at"]) if (typeof p[key] === "string" && p[key]) item[key] = str(p[key], 400);
      return [item];
    });
    return { type: "ui-state", agents, thread, approvals, ...(message.desktopPill === true ? { desktopPill: true } : {}) };
  }

  function framePage(url) {
    if (typeof url !== "string") return null;
    const base = url.split(/[?#]/)[0];
    return FRAME_PAGES.find((page) => base === chrome.runtime.getURL(page)) || null;
  }

  function nonceOf(url) {
    try { return new URL(url).searchParams.get("n") || ""; } catch { return ""; }
  }

  function loadNonces() {
    if (!noncesLoad) {
      const area = chrome.storage && chrome.storage.session;
      noncesLoad = (area ? area.get(NONCE_KEY) : Promise.resolve({})).then((stored) => {
        const saved = stored && stored[NONCE_KEY];
        if (saved && typeof saved === "object") {
          for (const [tab, list] of Object.entries(saved)) if (Array.isArray(list)) noncesByTab.set(Number(tab), list.filter((n) => typeof n === "string"));
        }
      }).catch(() => {});
    }
    return noncesLoad;
  }

  async function saveNonces() {
    const area = chrome.storage && chrome.storage.session;
    if (area) await area.set({ [NONCE_KEY]: Object.fromEntries(noncesByTab) }).catch(() => {});
  }

  /** The one check every pill/composer message and port goes through. */
  async function isOwnFrame(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!framePage(sender.url)) return false;
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isSafeInteger(tabId)) return false;
    const nonce = nonceOf(sender.url);
    if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
    await loadNonces();
    return (noncesByTab.get(tabId) || []).includes(nonce);
  }

  /** Only a top-frame content script on an ordinary page may register a nonce. */
  function isOwnContentScript(sender) {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
    return typeof sender.url === "string" && /^https?:\/\//.test(sender.url);
  }

  async function registerNonce(sender, nonce) {
    if (!/^[0-9a-f]{32}$/.test(nonce || "")) return false;
    await loadNonces();
    const list = (noncesByTab.get(sender.tab.id) || []).filter((n) => n !== nonce);
    list.push(nonce);
    noncesByTab.set(sender.tab.id, list.slice(-MAX_NONCES_PER_TAB));
    await saveNonces();
    return true;
  }

  async function selectionFor(tabId) {
    try {
      const reply = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: "m9r-pill-selection" }, { frameId: 0 }),
        new Promise((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      return reply && typeof reply.selection === "string" ? reply.selection.slice(0, 2000) : "";
    } catch {
      return "";
    }
  }

  /** Owner command from a validated frame -> one broker message, or an error the frame can show. */
  async function brokerMessageFor(command, sender) {
    if (!command || typeof command.type !== "string") return { error: "bad command" };
    if (command.type === "ui-command") {
      const text = typeof command.text === "string" ? command.text.trim() : "";
      if (!text || text.length > 4000) return { error: "message is empty or too long" };
      const tab = sender.tab || {};
      return { message: { type: "ui-command", text, context: { url: str(tab.url, 2000), title: str(tab.title, 300), selection: await selectionFor(tab.id) } } };
    }
    if (command.type === "ui-approve" || command.type === "ui-deny") {
      if (typeof command.id !== "string" || !command.id || command.id.length > 128) return { error: "bad approval id" };
      return { message: { type: command.type, id: command.id } };
    }
    if (command.type === "ui-stop") {
      if (typeof command.agent !== "string" || !command.agent || command.agent.length > 64) return { error: "bad agent" };
      return { message: { type: "ui-stop", agent: command.agent } };
    }
    if (command.type === "ui-save-note") {
      const text = typeof command.text === "string" ? command.text.trim() : "";
      if (!text || text.length > 2000) return { error: "note is empty or too long" };
      return { message: { type: "ui-save-note", text } };
    }
    if (command.type === "ui-stop-all") return { message: { type: "ui-stop-all" } };
    return { error: "unknown command" };
  }

  async function onRuntimeMessage(message, sender) {
    if (message.type === "m9r-pill-register") {
      if (!isOwnContentScript(sender)) return { ok: false, error: "not allowed" };
      return { ok: await registerNonce(sender, message.nonce) };
    }
    if (message.type === "m9r-pill-cmd") {
      if (!await isOwnFrame(sender)) return { ok: false, error: "commands are only accepted from the M9R pill" };
      const built = await brokerMessageFor(message.command, sender);
      if (built.error) return { ok: false, error: built.error };
      if (!sendToBroker(built.message)) return { ok: false, error: "the local M9R broker is not connected" };
      return { ok: true };
    }
    if (message.type === "m9r-pill-open-mic-setup") {
      if (!await isOwnFrame(sender)) return { ok: false };
      await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html?mic=1") });
      return { ok: true };
    }
    if (message.type === "m9r-pill-focus-composer") {
      if (!await isOwnFrame(sender)) return { ok: false };
      chrome.tabs.sendMessage(sender.tab.id, { type: "m9r-composer-show", focus: true }, { frameId: 0 }).catch(() => {});
      return { ok: true };
    }
    return undefined;
  }

  async function activeTabIds() {
    try {
      return new Set((await chrome.tabs.query({ active: true })).map((tab) => tab.id));
    } catch {
      return new Set();
    }
  }

  function post(port, payload) {
    try { port.postMessage(payload); } catch { ports.delete(port); }
  }

  function statusMessage() {
    return { type: "m9r-broker", connected: !!brokerConnected() };
  }

  async function broadcastState() {
    if (!lastState) return;
    const active = await activeTabIds();
    const payload = currentState();
    for (const port of ports) if (active.has(port.sender.tab.id)) post(port, payload);
    // Cursor lifecycle: content scripts learn which agents are still running, never the thread text.
    const agents = (lastState ? lastState.agents : []).map(({ id, provider, state }) => ({ id, provider, state }));
    const tabs = new Set([...ports].map((port) => port.sender.tab.id));
    for (const tabId of tabs) chrome.tabs.sendMessage(tabId, { type: "m9r-agents", agents }, { frameId: 0 }).catch(() => {});
  }

  function broadcastStatus() {
    const status = statusMessage();
    for (const port of ports) post(port, status);
  }

  async function onConnect(port) {
    if (!port || port.name !== "m9r-pill") return;
    if (!await isOwnFrame(port.sender)) {
      try { port.disconnect(); } catch {}
      return;
    }
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    post(port, statusMessage());
    if (lastState) post(port, currentState());
  }

  // ---- Content scripts on every site the owner has allowed (and nowhere else). ----
  let syncing = Promise.resolve();
  // The development manifest injects on loopback pages with static content scripts, so those are left out here; the store build has
  // no static scripts (they are not allowed there), so loopback pages are registered like any other allowed site.
  function hasStaticInjection() {
    try {
      const manifest = chrome.runtime.getManifest && chrome.runtime.getManifest();
      return manifest ? Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0 : true;
    } catch { return true; }
  }
  function siteOrigins(origins) {
    const skipLocal = hasStaticInjection();
    let staticMatches = [];
    try {
      staticMatches = (chrome.runtime.getManifest?.().content_scripts || [])
        .filter((script) => CONTENT_JS.every((file) => script.js?.includes(file)))
        .flatMap((script) => script.matches || []);
    } catch { /* unavailable manifest: retain the existing loopback safeguard */ }
    return (origins || []).filter((o) => {
      if (!/^https?:\/\//.test(o) || (skipLocal && LOCAL_ORIGINS.includes(o))) return false;
      const scheme = o.startsWith("https:") ? "https" : "http";
      return !staticMatches.includes(o) && !staticMatches.includes(`${scheme}://*/*`) && !staticMatches.includes("<all_urls>");
    }).sort();
  }

  function syncSiteScripts() {
    syncing = syncing.catch(() => {}).then(async () => {
      if (!chrome.scripting || !chrome.scripting.registerContentScripts || !chrome.permissions || !chrome.permissions.getAll) return;
      const { origins } = await chrome.permissions.getAll();
      const matches = siteOrigins(origins);
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPT_ID] });
      if (!matches.length) {
        if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SITE_SCRIPT_ID] });
        return;
      }
      const script = { id: SITE_SCRIPT_ID, matches, ...(hasStaticInjection() ? { excludeMatches: LOCAL_ORIGINS } : {}), js: CONTENT_JS, runAt: "document_idle", allFrames: false, persistAcrossSessions: true };
      if (existing.length) await chrome.scripting.updateContentScripts([script]);
      else await chrome.scripting.registerContentScripts([script]);
    });
    return syncing;
  }

  async function injectIntoOpenTabs(origins) {
    const matches = siteOrigins(origins);
    if (!matches.length) return;
    try {
      for (const tab of await chrome.tabs.query({ url: matches })) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_JS }).catch(() => {});
      }
    } catch {}
  }

  function init(options) {
    if (options && typeof options.send === "function") sendToBroker = options.send;
    if (options && typeof options.connected === "function") brokerConnected = options.connected;
    if (chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.type !== "string" || !message.type.startsWith("m9r-pill")) return undefined;
        void onRuntimeMessage(message, sender).then((reply) => sendResponse(reply || { ok: false }), () => sendResponse({ ok: false }));
        return true;
      });
    }
    if (chrome.runtime.onConnect) chrome.runtime.onConnect.addListener((port) => void onConnect(port));
    if (chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(({ tabId }) => {
        if (!lastState) return;
        for (const port of ports) if (port.sender.tab.id === tabId) post(port, currentState());
      });
    }
    if (chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        void loadNonces().then(() => { if (noncesByTab.delete(tabId)) return saveNonces(); });
      });
    }
    if (chrome.permissions && chrome.permissions.onAdded) {
      chrome.permissions.onAdded.addListener((added) => { void syncSiteScripts().then(() => injectIntoOpenTabs(added && added.origins)); });
      chrome.permissions.onRemoved.addListener(() => void syncSiteScripts());
    }
    if (chrome.commands && chrome.commands.onCommand) {
      chrome.commands.onCommand.addListener((name) => {
        const type = name === "toggle-message-bar" ? "m9r-composer-toggle" : name === "toggle-thread-pill" ? "m9r-pill-toggle" : null;
        if (!type) return;
        void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
          if (tab && Number.isSafeInteger(tab.id)) chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 }).catch(() => {});
        });
      });
    }
    void syncSiteScripts().catch((e) => chrome.storage.session.set({ m9rSyncErr: String(e && e.message) }));
  }

  global.M9RPillBridge = {
    init,
    state(message) { lastState = sanitizeState(message); void broadcastState(); },
    brokerOpen() { sendToBroker({ type: "ui-subscribe" }); broadcastStatus(); },
    brokerClosed() { broadcastStatus(); },
    // Exposed for tests.
    _internals: { isOwnFrame, isOwnContentScript, sanitizeState, brokerMessageFor, onRuntimeMessage, onConnect, syncSiteScripts, ports },
  };
})(typeof self !== "undefined" ? self : globalThis);
