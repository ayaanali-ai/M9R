// Shared by pill.html (the thread pill) and composer.html (the message bar). Both run as extension pages inside frames
// that M9R's content script mounts in a closed shadow root; they talk to the background, never to the page.
(function (global) {
  "use strict";

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

  function ringOf(state) {
    if (state === "working" || state === "starting") return "working";
    if (state === "waiting") return "waiting";
    if (state === "blocked" || state === "failed") return "blocked";
    if (state === "idle") return "idle";
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
    try { global.parent.postMessage({ m9r: "frame", ...payload }, "*"); } catch {}
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
      toParent({ kind: "drag", dx, dy });
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
  global.addEventListener("message", (event) => {
    // Host messages come from our own content script via the page window; only layout hints are accepted.
    const data = event.data;
    if (!data || data.m9r !== "host" || event.source !== global.parent) return;
    if (data.kind === "host" && Number.isFinite(data.vw) && Number.isFinite(data.vh)) {
      host.vw = data.vw;
      host.vh = data.vh;
    }
    for (const fn of hostListeners) fn(data);
  });

  global.M9RFrame = {
    PROVIDERS, providerOf, el, chip, ringOf, displayName, ago, toParent, command, draggable, host,
    onState(fn) { listeners.add(fn); if (store.state || store.connected) fn(store); },
    onHost(fn) { hostListeners.add(fn); },
    store,
    start: connect,
  };
})(window);
