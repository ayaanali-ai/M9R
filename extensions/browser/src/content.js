(function () {
  "use strict";
  if (window.top !== window) return;
  if (document.getElementById(window.M9RPresence.ROOT_ID)) return;

  const overlay = window.M9RPresence.createPresenceOverlay(document, {
    onMessageVisibility(sessionId, show) {
      try { chrome.runtime.sendMessage({ type: "m9r-message-visibility", sessionId, show }); } catch {}
    },
  });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "presence") overlay.update(msg);
      else if (msg && msg.type === "owner-stop") overlay.stop(msg.owner);
      else if (msg && msg.type === "owner-resume") overlay.resume();
    });
  }

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
    if (msg.type === "leave") overlay.remove(String(msg.agent || ""));
    else overlay.update(msg);
  });
})();
