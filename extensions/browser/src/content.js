(function () {
  "use strict";
  if (window.top !== window) return;
  // The dashboard already has its own in-page chat, composer and @mention menu. The floating presence overlay (the pill,
  // the dock) is for agents working on OTHER pages; on M9R's own dashboard it has nothing to show and only sits on top of
  // the app, at a higher z-index than the app's own @mention menu, catching its clicks. The dashboard marks its own pages
  // with data-m9r-app-shell (src/app/dashboard/layout.tsx) specifically so this check never depends on guessing a
  // hostname or port, which would be wrong for a dev server or a future domain.
  if (typeof document.querySelector === "function" && document.querySelector("[data-m9r-app-shell]")) return;
  // The document can outlive an MV3 service worker. The previous content script must release its
  // listeners, timers and overlay before another injection claims the same document.
  if (typeof window.__m9rContentDispose === "function") window.__m9rContentDispose();
  else document.getElementById(window.M9RPresence.ROOT_ID)?.remove();
  const myGeneration = Symbol("m9r-content-generation");
  window.__m9rContentGeneration = myGeneration;
  const current = () => window.__m9rContentGeneration === myGeneration;
  const cleanups = [];
  let overlay = null;
  window.__m9rContentDispose = () => {
    if (!current()) return;
    window.__m9rContentGeneration = null;
    // Chrome can invalidate the old runtime during an extension reload. One failed removal must
    // never strand the other DOM listeners, timers, or the visible overlay.
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch {} }
    try { overlay?.destroy(); } catch {}
    window.__m9rContentDispose = null;
  };

  // The Alt+M / Alt+N gestures live below; frames forward their key events here through this hook.
  let onHotkey = () => {};
  overlay = window.M9RPresence.createPresenceOverlay(document, {
    onMessageVisibility(sessionId, show) {
      try { chrome.runtime.sendMessage({ type: "m9r-message-visibility", sessionId, show }); } catch {}
    },
    onHotkey(key, down) { onHotkey(key, down); },
  });
  const lifecycleHooks = {
    suspend() { if (current() && typeof overlay.suspend === "function") overlay.suspend(); },
    resume() { if (current() && typeof overlay.resume === "function") overlay.resume(); },
  };
  window.__m9rContentLifecycleHooks = lifecycleHooks;
  cleanups.push(() => {
    if (window.__m9rContentLifecycleHooks === lifecycleHooks) delete window.__m9rContentLifecycleHooks;
  });
  if (!window.__m9rContentPageLifecycle) {
    const pageLifecycle = {
      onPageHide(event) {
        if (event && event.persisted && window.__m9rContentLifecycleHooks) window.__m9rContentLifecycleHooks.suspend();
      },
      onPageShow(event) {
        if (event && event.persisted && window.__m9rContentLifecycleHooks) window.__m9rContentLifecycleHooks.resume();
      },
    };
    window.addEventListener("pagehide", pageLifecycle.onPageHide);
    window.addEventListener("pageshow", pageLifecycle.onPageShow);
    window.__m9rContentPageLifecycle = pageLifecycle;
  }
  try {
    chrome.runtime.sendMessage({ type: "m9r-get-zoom" }, (reply) => {
      void chrome.runtime.lastError;
      if (current() && reply && reply.zoom) overlay.setZoom(reply.zoom);
    });
  } catch {}
  // The Alt+M and Alt+N commands may also fire (when Chrome has them assigned). If this script already handled the same key press,
  // the command is a duplicate and is ignored.
  // Holding a key makes Chrome repeat the command every few milliseconds, so a command is also ignored while a press is in progress
  // and for a moment after it, and commands are never accepted more than once per 700 ms.
  // A small ring buffer of hotkey events for troubleshooting (permission.html?debug=1). It records only Alt+M / Alt+N presses and what
  // the overlay did about them, never typed text.
  const keyLog = [];
  let keyLogTimer = 0;
  const logKey = (src, what) => {
    keyLog.push({ t: Date.now(), src, what });
    if (keyLog.length > 80) keyLog.shift();
    if (keyLogTimer) return;
    keyLogTimer = setTimeout(() => {
      keyLogTimer = 0;
      try {
        chrome.storage.local.get("m9rKeyLog").then((stored) => {
          const previous = Array.isArray(stored.m9rKeyLog) ? stored.m9rKeyLog : [];
          return chrome.storage.local.set({ m9rKeyLog: previous.concat(keyLog.splice(0)).slice(-120) });
        }).catch(() => {});
      } catch {}
    }, 250);
  };
  let lastHotkeyAt = 0;
  let pressStartedAt = 0;
  let lastCommandAt = 0;
  const commandAllowed = () => {
    const now = Date.now();
    if (pressStartedAt && now - pressStartedAt < 8000) return false;
    if (now - lastHotkeyAt < 1200 || now - lastCommandAt < 700) return false;
    lastCommandAt = now;
    return true;
  };

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    const onRuntimeMessage = (msg, _sender, sendResponse) => {
      if (!current()) return;
      if (msg && msg.type === "presence") {
        overlay.update(msg);
        if (msg.phase === "done") {
          // Confirm only after a paint opportunity and only if this generation still shows the matching session.
          requestAnimationFrame(() => {
            if (!current()) return;
            let rendered = false;
            try { rendered = overlay.isDoneVisible(msg.agent, msg.sessionId) === true; } catch {}
            sendResponse({ rendered });
          });
          return true;
        }
        // For actions aimed at an element, hold the reply until the cursor has landed so the page action happens after it arrives.
        if (msg.phase !== "done" && msg.target && (msg.target.selector || msg.target.rect) && typeof overlay.whenArrived === "function") {
          overlay.whenArrived(msg.agent, 1000).then(() => { if (current()) sendResponse({ arrived: true }); });
          return true;
        }
      }
      else if (msg && msg.type === "m9r-zoom") overlay.setZoom(msg.zoom);
      else if (msg && msg.type === "m9r-native-pointer") {
        const painted = overlay.nativePointer(msg.agent, msg.x, msg.y, msg.active === true);
        if (msg.phase === "arrived") {
          Promise.resolve(painted).then(
            (visible) => { if (current()) sendResponse({ painted: visible === true }); },
            () => { if (current()) sendResponse({ painted: false }); },
          );
          return true;
        }
      }
      else if (msg && msg.type === "owner-stop") overlay.stop(msg.owner);
      else if (msg && msg.type === "owner-resume") overlay.resume();
      else if (msg && msg.type === "m9r-agents") overlay.syncAgents(msg.agents);
      else if (msg && msg.type === "m9r-composer-toggle") { const ok = commandAllowed(); logKey("command", ok ? "bar toggle accepted" : "bar toggle ignored"); if (ok) overlay.toggleComposer(); }
      else if (msg && msg.type === "m9r-pill-toggle") { const ok = commandAllowed(); logKey("command", ok ? "pill toggle accepted" : "pill toggle ignored"); if (ok) overlay.togglePill(); }
      else if (msg && msg.type === "m9r-composer-show") overlay.showComposer(msg.focus === true);
      else if (msg && msg.type === "m9r-pill-selection") {
        let selection = "";
        try { selection = String(window.getSelection() || "").slice(0, 2000); } catch {}
        sendResponse({ selection });
      }
    };
    let bridge = window.__m9rContentRuntimeBridge;
    if (!bridge) {
      bridge = { handler: null };
      bridge.listener = (...args) => { if (bridge.handler) return bridge.handler(...args); };
      window.__m9rContentRuntimeBridge = bridge;
      try { chrome.runtime.onMessage.addListener(bridge.listener); }
      catch (error) {
        if (window.__m9rContentRuntimeBridge === bridge) delete window.__m9rContentRuntimeBridge;
        throw error;
      }
    }
    bridge.handler = onRuntimeMessage;
    cleanups.push(() => {
      if (bridge.handler === onRuntimeMessage) bridge.handler = null;
      try {
        chrome.runtime.onMessage.removeListener(bridge.listener);
        if (window.__m9rContentRuntimeBridge === bridge) delete window.__m9rContentRuntimeBridge;
      } catch { /* Reuse this single inert bridge if Chrome refuses removal during invalidation. */ }
    });
  }

  // The thread pill and the message bar are extension pages in frames inside the overlay's closed shadow root, so the
  // page never sees what the owner types. Each frame carries a one-time nonce registered for this tab; the background
  // only accepts owner commands from a frame whose nonce it knows.
  if (chrome.runtime && typeof chrome.runtime.getURL === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const WAKE_W = 240;
    const WAKE_H = 6;
    const setRegistrationStage = (stage) => {
      try {
        const host = document.getElementById(window.M9RPresence.ROOT_ID);
        if (current() && host && host.isConnected && host.dataset) host.dataset.m9rRegistration = stage;
      } catch {}
    };
    setRegistrationStage("pending");
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: "m9r-pill-register", nonce })).then((reply) => {
        if (!current()) return;
        if (!reply || reply.ok !== true) {
          setRegistrationStage("rejected");
          return;
        }
        // One pill: the agents, approvals and message box are a single extension frame, so a page's scripts cannot read what the owner types.
        const pill = overlay.mountFrame("pill", chrome.runtime.getURL(`pill-next/index.html?n=${nonce}`), { w: WAKE_W, h: WAKE_H, top: 0 });
        setRegistrationStage(pill ? "accepted" : "mount-failed");
      }).catch(() => setRegistrationStage("error"));
    } catch {
      setRegistrationStage("error");
    }
  }

  // Alt+M: tap opens or closes the message bar; hold (past the delay) talks until the key comes up. Alt+N shows or hides the thread
  // pill. Handled here instead of relying on Chrome's shortcut assignment, so it works wherever this script sees the key.
  (function hotkeys() {
    const HOLD_MS = 280;
    let holdTimer = 0;
    let talking = false;
    let tapPending = false;
    const finish = () => {
      logKey("page", talking ? "release after hold: stop talking" : tapPending ? "release after tap: toggle bar" : "release (nothing pending)");
      pressStartedAt = 0;
      lastHotkeyAt = Date.now();
      clearTimeout(holdTimer);
      if (talking) { talking = false; overlay.talk(false); }
      else if (tapPending) overlay.toggleComposer();
      tapPending = false;
    };
    const press = (key) => {
      logKey("page", `press Alt+${key.toUpperCase()}`);
      lastHotkeyAt = pressStartedAt = Date.now();
      if (key === "n") { overlay.togglePill(); return; }
      clearTimeout(holdTimer);
      talking = false;
      tapPending = true;
      holdTimer = setTimeout(() => { logKey("page", "held: start talking"); tapPending = false; talking = true; overlay.talk(true); }, HOLD_MS);
    };
    const release = (key) => { if (key === "m") finish(); else { pressStartedAt = 0; lastHotkeyAt = Date.now(); } };
    onHotkey = (key, down) => { logKey("frame", `${down ? "down" : "up"} ${key}`); if (down) press(key); else release(key); };
    const isKey = (ev, code) => ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === code;
    const onKeyDown = (ev) => {
      if (!current()) return;
      if (ev.repeat) return;
      if (isKey(ev, "KeyM")) press("m");
      else if (isKey(ev, "KeyN")) press("n");
    };
    const onKeyUp = (ev) => {
      if (!current()) return;
      if (ev.code === "KeyM" || ev.key === "Alt") finish();
      else if (ev.code === "KeyN") release("n");
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    cleanups.push(() => {
      clearTimeout(holdTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    });
  })();

  const onPresence = (event) => {
    if (!current()) return;
    let msg = event.detail;
    if (typeof msg === "string") {
      try {
        msg = JSON.parse(msg);
      } catch {
        return;
      }
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "leave") overlay.leave(String(msg.agent || ""));
    else overlay.update(msg);
  };
  document.addEventListener("m9r:presence", onPresence);
  cleanups.push(() => document.removeEventListener("m9r:presence", onPresence));
  cleanups.push(() => clearTimeout(keyLogTimer));
})();
