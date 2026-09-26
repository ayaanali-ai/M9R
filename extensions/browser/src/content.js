(function () {
  "use strict";
  if (window.top !== window) return;
  if (document.getElementById(window.M9RPresence.ROOT_ID)) return;

  // The Alt+M / Alt+N gestures live below; frames forward their key events here through this hook.
  let onHotkey = () => {};
  const overlay = window.M9RPresence.createPresenceOverlay(document, {
    onMessageVisibility(sessionId, show) {
      try { chrome.runtime.sendMessage({ type: "m9r-message-visibility", sessionId, show }); } catch {}
    },
    onHotkey(key, down) { onHotkey(key, down); },
  });
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
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "presence") {
        overlay.update(msg);
        // For actions aimed at an element, hold the reply until the cursor has landed so the page action happens after it arrives.
        if (msg.phase !== "done" && msg.target && (msg.target.selector || msg.target.rect) && typeof overlay.whenArrived === "function") {
          overlay.whenArrived(msg.agent, 2000).then(() => sendResponse({ arrived: true }));
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
    });
  }

  // The thread pill and the message bar are extension pages in frames inside the overlay's closed shadow root, so the
  // page never sees what the owner types. Each frame carries a one-time nonce registered for this tab; the background
  // only accepts owner commands from a frame whose nonce it knows.
  if (chrome.runtime && typeof chrome.runtime.getURL === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    chrome.runtime.sendMessage({ type: "m9r-pill-register", nonce }).then((reply) => {
      if (!reply || !reply.ok) return;
      overlay.mountFrame("pill", chrome.runtime.getURL(`pill.html?n=${nonce}`), { w: 372, h: 76, bottom: 76 });
      overlay.mountFrame("composer", chrome.runtime.getURL(`composer.html?n=${nonce}`), { w: 448, h: 72, bottom: 6 });
    }).catch(() => {});
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
    window.addEventListener("keydown", (ev) => {
      if (ev.repeat) return;
      if (isKey(ev, "KeyM")) press("m");
      else if (isKey(ev, "KeyN")) press("n");
    }, true);
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "KeyM" || ev.key === "Alt") finish();
      else if (ev.code === "KeyN") release("n");
    }, true);
  })();

  document.addEventListener("m9r:presence", (event) => {
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
  });
})();
