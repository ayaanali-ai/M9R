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
  const site = document.getElementById("site");
  const scope = document.getElementById("scope");
  const status = document.getElementById("status");
  const stopAll = document.getElementById("stop-all");
  document.querySelector("h1").textContent = "M9R browser access";
  document.querySelector("main > p").textContent = "M9R requests ordinary website access when Chrome installs the extension.";
  scope.textContent = "M9R has no per-site prompt. Chrome can still withhold or revoke site access in its extension settings.";
  void chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }).then((granted) => {
    site.textContent = granted ? "Ordinary websites available" : "Chrome has withheld all-site access";
    status.textContent = granted ? "Agent actions still obey M9R scopes and consequential-action approvals." : "Enable site access in Chrome's extension settings to use M9R on websites.";
  }).catch(() => { site.textContent = "Site access status unavailable"; });
  const quietToggle = document.getElementById("quiet-toggle");
  const quietStatus = document.getElementById("quiet-status");
  const paintQuiet = async () => {
    const stored = await chrome.storage.local.get("m9rQuietMode").catch(() => ({}));
    const on = stored.m9rQuietMode === true && await chrome.permissions.contains({ permissions: ["debugger"] }).catch(() => false);
    quietToggle.textContent = on ? "Turn off quiet mode" : "Turn on quiet mode";
    quietStatus.textContent = on ? "Quiet mode is on." : "Quiet mode is off. Agents use the standard click.";
    return on;
  };
  void paintQuiet();
  quietToggle.addEventListener("click", async () => {
    quietToggle.disabled = true;
    try {
      if (await paintQuiet()) {
        await chrome.storage.local.set({ m9rQuietMode: false });
        await chrome.permissions.remove({ permissions: ["debugger"] }).catch(() => false);
      } else {
        const granted = await chrome.permissions.request({ permissions: ["debugger"] });
        await chrome.storage.local.set({ m9rQuietMode: granted === true });
        if (!granted) quietStatus.textContent = "Chrome did not grant the permission, so quiet mode stays off.";
      }
    } finally {
      quietToggle.disabled = false;
      const text = quietStatus.textContent;
      await paintQuiet();
      if (/did not grant/.test(text)) quietStatus.textContent = text;
    }
  });
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
