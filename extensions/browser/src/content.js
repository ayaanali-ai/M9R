(function () {
  "use strict";
  if (window.top !== window) return;
  if (document.getElementById(window.M9RPresence.ROOT_ID)) return;

  // Set by the push-to-talk gesture below; the message bar calls it when Alt or M comes up inside its own frame.
  let onTalkRelease = () => {};
  const overlay = window.M9RPresence.createPresenceOverlay(document, {
    onMessageVisibility(sessionId, show) {
      try { chrome.runtime.sendMessage({ type: "m9r-message-visibility", sessionId, show }); } catch {}
    },
    onTalkRelease() { onTalkRelease(); },
  });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "presence") {
        overlay.update(msg);
        // For actions aimed at an element, hold the reply until the cursor has landed so the page action happens after it arrives.
        if (msg.phase !== "done" && msg.target && msg.target.selector && typeof overlay.whenArrived === "function") {
          overlay.whenArrived(msg.agent, 2000).then(() => sendResponse({ arrived: true }));
          return true;
        }
      }
      else if (msg && msg.type === "owner-stop") overlay.stop(msg.owner);
      else if (msg && msg.type === "owner-resume") overlay.resume();
      else if (msg && msg.type === "m9r-agents") overlay.syncAgents(msg.agents);
      else if (msg && msg.type === "m9r-composer-toggle") overlay.toggleComposer();
      else if (msg && msg.type === "m9r-pill-toggle") overlay.togglePill();
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

  // Push-to-talk: hold Alt+M. A tap is left to the Alt+M command (it opens or closes the bar); holding past the delay starts
  // speech in the bar. The Alt+M command also focuses the bar, so the key can come up in the bar's frame instead of here: the
  // frame then reports it (onTalkRelease) so a tap cancels the pending talk and a hold ends it.
  (function pushToTalk() {
    const HOLD_MS = 280;
    let holdTimer = 0;
    let talking = false;
    const isTalkKey = (ev) => ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === "KeyM";
    const stopTalk = () => {
      clearTimeout(holdTimer);
      if (talking) { talking = false; overlay.talk(false); }
    };
    onTalkRelease = stopTalk;
    window.addEventListener("keydown", (ev) => {
      if (!isTalkKey(ev) || ev.repeat) return;
      clearTimeout(holdTimer);
      talking = false;
      holdTimer = setTimeout(() => { talking = true; overlay.talk(true); }, HOLD_MS);
    }, true);
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "KeyM" || ev.key === "Alt") stopTalk();
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
