(function () {
  "use strict";

  const params = new URLSearchParams(location.search);

  // Two small tool modes share this page (the store package only ships this one page): ?mic=1 turns the microphone on once for the
  // whole extension, and ?debug=1 shows the recent Alt+M / Alt+N key events.
  if (params.has("mic") || params.has("debug")) {
    document.getElementById("site-panel").hidden = true;
    if (params.has("mic")) {
      document.getElementById("mic-panel").hidden = false;
      const micStatus = document.getElementById("mic-status");
      document.getElementById("mic-allow").addEventListener("click", async () => {
        micStatus.textContent = "Waiting for Chrome…";
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          micStatus.textContent = "Microphone is on. Close this tab, then hold Alt+M on any page to talk.";
        } catch (error) {
          micStatus.textContent = error && error.name === "NotAllowedError"
            ? "Chrome blocked the microphone. Click the lock icon next to the address bar and allow it for M9R, then try again."
            : `The microphone could not start (${error && error.name ? error.name : "unknown error"}).`;
        }
      });
    } else {
      document.getElementById("debug-panel").hidden = false;
      const log = document.getElementById("debug-log");
      const draw = async () => {
        const stored = await chrome.storage.local.get("m9rKeyLog");
        const list = Array.isArray(stored.m9rKeyLog) ? stored.m9rKeyLog : [];
        const t0 = list.length ? list[0].t : 0;
        log.textContent = list.length ? list.map((e) => `${String(e.t - t0).padStart(7)} ms  ${String(e.src).padEnd(8)} ${e.what}`).join("\n") : "Nothing yet. Press Alt+M or Alt+N on a normal page.";
      };
      document.getElementById("debug-clear").addEventListener("click", async () => { await chrome.storage.local.remove("m9rKeyLog"); await draw(); });
      void draw();
      setInterval(draw, 800);
    }
    return;
  }
  let grant = window.M9RPermissionLogic.normalizeApprovedGrant({
    grantId: params.get("grantId"), origin: params.get("origin"), pathPrefix: params.get("pathPrefix"),
    actions: (params.get("actions") || "").split(","),
  });
  let ownerInitiated = false;
  const site = document.getElementById("site");
  const scope = document.getElementById("scope");
  const status = document.getElementById("status");
  const allow = document.getElementById("allow");
  const deny = document.getElementById("deny");
  const stopAll = document.getElementById("stop-all");
  allow.disabled = true;
  async function initialize() {
    if (!grant) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const origin = window.M9RPermissionLogic.normalizeOrigin(tab?.url || "");
      if (!origin) {
        site.textContent = "Open a normal website, then reopen this M9R extension panel.";
        allow.disabled = true;
        deny.disabled = true;
        return;
      }
      ownerInitiated = true;
      grant = { grantId: "", origin, pathPrefix: "/", actions: ["open", "read", "click", "type"] };
      document.querySelector("h1").textContent = "Allow M9R on this site?";
      document.querySelector("main > p").textContent = "You are granting your own M9R agents browser access to:";
      scope.textContent = "Owner access · site-wide Chrome permission. M9R only acts when you ask it to.";
      allow.textContent = "Allow this site";
      if (allowAll) allowAll.hidden = false;
      deny.textContent = "Cancel";
    } else {
      scope.textContent = `Grant scope: ${grant.pathPrefix} · Actions: ${grant.actions.join(", ") || "none"}`;
    }
    site.textContent = new URL(grant.origin).host;
    allow.disabled = false;
  }
  const allowAll = document.getElementById("allow-all");
  void initialize();
  // Owner-initiated only: one click to let their own agents research across many sites; risky actions still wait for approval.
  if (allowAll) {
    allowAll.addEventListener("click", async () => {
      allowAll.disabled = true;
      status.textContent = "Waiting for Chrome…";
      try {
        const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
        status.textContent = granted ? "All websites allowed for your own M9R agents. Submit, buy, post and delete still wait for you." : "No extra access was added.";
      } catch {
        status.textContent = "Chrome did not grant all-site access.";
      }
      allowAll.disabled = false;
    });
  }

  async function finish(granted) {
    if (ownerInitiated) {
      status.textContent = granted ? "Site access enabled for your own M9R agents." : "No site access was added.";
      allow.disabled = true;
      deny.disabled = true;
      return;
    }
    allow.disabled = true;
    deny.disabled = true;
    try { await chrome.runtime.sendMessage({ type: "m9r-permission-result", grantId: grant.grantId, origin: grant.origin, granted }); }
    catch { /* broker may be offline; enforcement still fails closed in background.js */ }
    status.textContent = granted ? "Site access is enabled. You can close this tab." : "No site access was added. The M9R grant has been stopped.";
  }

  allow.addEventListener("click", async () => {
    allow.disabled = true;
    status.textContent = "Waiting for Chrome…";
    try {
      const pattern = window.M9RPermissionLogic.permissionPattern(grant.origin);
      const granted = pattern ? await chrome.permissions.request({ origins: [pattern] }) : false;
      if (ownerInitiated && !granted) allow.disabled = false;
      await finish(granted);
    } catch {
      status.textContent = "Chrome did not grant this site. The M9R grant remains blocked.";
      await finish(false);
    }
  });
  deny.addEventListener("click", () => void finish(false));
  stopAll.addEventListener("click", async () => {
    stopAll.disabled = true;
    status.textContent = "Sending stop signal to the local broker…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "m9r-owner-stop-all" });
      status.textContent = result?.ok
        ? "Stopped. Restart the local M9R web broker to resume browser actions."
        : (result?.error || "The stop signal could not be sent.");
    } catch {
      status.textContent = "The stop signal could not reach the local broker.";
    } finally {
      stopAll.disabled = false;
    }
  });
})();
