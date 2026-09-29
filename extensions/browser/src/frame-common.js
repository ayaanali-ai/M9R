// Shared by pill.html (the thread pill) and composer.html (the message bar). Both run as extension pages inside frames
// that M9R's content script mounts in a closed shadow root; they talk to the background, never to the page.
(function (global) {
  "use strict";

  const frameNonce = new URL(global.location.href).searchParams.get("n") || "";

  const PROVIDERS = {
    claude: { name: "Claude", cls: "p-claude" },
    codex: { name: "Codex", cls: "p-codex" },
    opencode: { name: "OpenCode", cls: "p-opencode" },
    you: { name: "You", cls: "p-you" },
    agent: { name: "Agent", cls: "p-agent" },
  };

  function providerOf(value) {
    const v = String(value || "").toLowerCase();
    if (/claude|anthropic/.test(v)) return "claude";
    if (/codex|openai/.test(v)) return "codex";
    if (/opencode/.test(v)) return "opencode";
    if (v === "you" || v === "owner") return "you";
    return "agent";
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** The provider's own mark on a round chip; `ring` is the state ring (working/waiting/blocked/idle/off). */
  function chip(provider, cls, ring) {
    const p = PROVIDERS[providerOf(provider)] || PROVIDERS.agent;
    const node = el("span", cls || "chip");
    node.appendChild(el("span", `logo ${p.cls}`));
    if (ring) node.dataset.ring = ring;
    return node;
  }

  // "Just finished" and "never started" both used to render as the exact same plain dot -- no signal at all that a run
  // actually completed, which is why the end of a run was invisible unless you opened the panel and read the chat. A
  // freshly idle agent whose last word was "Done" gets its own distinct ring; it settles to the ordinary idle look the
  // moment the agent does anything else (a new task, a message).
  function ringOf(state, doing) {
    if (state === "working" || state === "starting") return "working";
    if (state === "waiting") return "waiting";
    if (state === "blocked" || state === "failed") return "blocked";
    if (state === "idle") return typeof doing === "string" && /^Done\b/.test(doing) ? "done" : "idle";
    return "off";
  }

  function displayName(agent, provider) {
    const id = String(agent || "").replace(/^@/, "");
    const p = PROVIDERS[providerOf(provider || id)];
    if (!id) return p ? p.name : "Agent";
    return p && id.toLowerCase() === p.name.toLowerCase() ? p.name : id;
  }

  function ago(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 10) return "now";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function toParent(payload) {
    // Only sizes and drag deltas go to the embedding page's window; nothing the owner types does.
    try { global.parent.postMessage({ m9r: "frame", nonce: frameNonce, ...payload }, "*"); } catch {}
  }

  const listeners = new Set();
  const store = { state: null, connected: false };
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "m9r-pill" });
    } catch {
      setTimeout(connect, 1500);
      return;
    }
    port.onMessage.addListener((message) => {
      if (!message) return;
      if (message.type === "ui-state") store.state = message;
      else if (message.type === "m9r-broker") store.connected = message.connected === true;
      else return;
      for (const fn of listeners) fn(store);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000);
    });
  }

  async function command(cmd) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "m9r-pill-cmd", command: cmd });
      return reply || { ok: false, error: "no reply" };
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      // After the extension is reloaded, a page that was already open keeps its old M9R frame, which can no longer reach it.
      if (/context invalidated|receiving end does not exist/i.test(message)) return { ok: false, error: "M9R was reloaded. Refresh this page (F5) and try again." };
      return { ok: false, error: message };
    }
  }

  /**
   * Drag the whole frame by pressing on `handle` (outside buttons and inputs) and moving. The frame moves under the
   * pointer, so deltas come from screen coordinates. Returns a function telling whether the last press was a drag.
   */
  function draggable(handle, isInteractive) {
    let press = null;
    let dragged = false;
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || (isInteractive && isInteractive(ev.target))) return;
      press = { x: ev.screenX, y: ev.screenY, id: ev.pointerId, moved: false };
      dragged = false;
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!press || ev.pointerId !== press.id) return;
      const dx = ev.screenX - press.x;
      const dy = ev.screenY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      if (!press.moved) {
        press.moved = true;
        try { handle.setPointerCapture(ev.pointerId); } catch {}
        document.body.classList.add("dragging");
      }
      press.x = ev.screenX;
      press.y = ev.screenY;
      toParent({ kind: "drag", dx, dy, cx: ev.clientX, cy: ev.clientY });
    });
    const end = (ev) => {
      if (!press || (ev && ev.pointerId !== press.id)) return;
      if (press.moved) {
        dragged = true;
        toParent({ kind: "drag-end" });
      }
      document.body.classList.remove("dragging");
      press = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("dblclick", (ev) => {
      if (isInteractive && isInteractive(ev.target)) return;
      toParent({ kind: "reset-position" });
    });
    return () => {
      const was = dragged;
      dragged = false;
      return was;
    };
  }

  const host = { vw: 1280, vh: 800 };
  const hostListeners = new Set();
  let hostPort = null;
  function applyHost(data) {
    if (!data || data.m9r !== "host" || data.nonce !== frameNonce) return;
    if (data.kind === "host" && Number.isFinite(data.vw) && Number.isFinite(data.vh)) {
      host.vw = data.vw;
      host.vh = data.vh;
    }
    for (const fn of hostListeners) fn(data);
  }
  global.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === global.parent && data?.m9r === "host-hello" && data.nonce === frameNonce) {
      toParent({ kind: "ready" });
      return;
    }
    if (event.source !== global.parent || !data || data.m9r !== "host-port" || data.nonce !== frameNonce || !event.ports?.[0]) return;
    try { hostPort?.close(); } catch {}
    hostPort = event.ports[0];
    hostPort.onmessage = (message) => applyHost(message.data);
    hostPort.start?.();
  });

  // Alt+M and Alt+N are handled by the page's content script, not by Chrome's shortcut registration (which can leave a suggested
  // shortcut unassigned). When focus is inside one of our frames the page never sees the keys, so the frame forwards them.
  const hotkeyOf = (ev) => (ev.altKey && !ev.ctrlKey && !ev.metaKey ? (ev.code === "KeyM" ? "m" : ev.code === "KeyN" ? "n" : "") : "");
  global.addEventListener("keydown", (ev) => {
    const key = hotkeyOf(ev);
    if (key && !ev.repeat) toParent({ kind: "hotkey", key, down: true });
  }, true);
  global.addEventListener("keyup", (ev) => {
    if (ev.key === "Alt" || hotkeyOf(ev)) toParent({ kind: "hotkey", key: ev.code === "KeyN" ? "n" : "m", down: false });
  }, true);

  // M9R's motion setting: "full" unless the person chose to follow the system.
  document.documentElement.dataset.motion = "full";
  try {
    chrome.storage.local.get("m9rMotion").then((stored) => { document.documentElement.dataset.motion = stored && stored.m9rMotion === "system" ? "system" : "full"; }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.m9rMotion) document.documentElement.dataset.motion = changes.m9rMotion.newValue === "system" ? "system" : "full"; });
  } catch { /* outside the extension (tests): stay on full */ }

  global.M9RFrame = {
    PROVIDERS, providerOf, el, chip, ringOf, displayName, ago, toParent, command, draggable, host,
    onState(fn) { listeners.add(fn); if (store.state || store.connected) fn(store); },
    onHost(fn) { hostListeners.add(fn); },
    store,
    start: connect,
  };
})(window);
