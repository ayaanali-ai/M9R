// Quiet input: delivers agent clicks and typing to a tab through Chrome's debugger protocol, so the owner's mouse, keyboard and
// focus are never used. The extension attaches only while an agent is acting and detaches after a quiet period, because Chrome
// shows a "started debugging this browser" banner while attached.
//
// Safety rules kept here (not in callers):
// - Only the commands in ALLOWED are ever sent; agents never reach the protocol directly.
// - Every refusal is an Error with a stable `code`; nothing silently falls back to the owner's real mouse.
// - Never touches a debugger session that something else (DevTools, another extension) already owns.
(function installM9rQuietInput(root) {
  const IDLE_DETACH_MS = 10000;
  const PROTOCOL = "1.3";
  const ALLOWED = new Set([
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Emulation.setFocusEmulationEnabled",
  ]);

  function refusal(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function create(api, options = {}) {
    const idleMs = Number.isFinite(options.idleMs) && options.idleMs >= 0 ? options.idleMs : IDLE_DETACH_MS;
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const sessions = new Map(); // tabId -> { attached, cancelled, stopped, timer, queue }

    function session(tabId) {
      let s = sessions.get(tabId);
      if (!s) { s = { attached: false, cancelled: false, stopped: false, timer: null, queue: Promise.resolve() }; sessions.set(tabId, s); }
      return s;
    }

    function send(tabId, method, params) {
      if (!ALLOWED.has(method)) return Promise.reject(refusal("method_not_allowed", `${method} is not an allowed quiet-input command`));
      return api.debugger.sendCommand({ tabId }, method, params || {});
    }

    function scheduleDetach(tabId) {
      const s = session(tabId);
      if (s.timer !== null) clearTimer(s.timer);
      s.timer = setTimer(() => { s.timer = null; void detach(tabId); }, idleMs);
    }

    async function detach(tabId) {
      const s = sessions.get(tabId);
      if (!s) return;
      if (s.timer !== null) { clearTimer(s.timer); s.timer = null; }
      if (!s.attached) return;
      s.attached = false;
      try { await api.debugger.detach({ tabId }); } catch { /* the tab may already be gone */ }
    }

    async function ensureAttached(tabId) {
      const s = session(tabId);
      if (s.stopped) throw refusal("stopped_by_owner", "The owner stopped browser input");
      if (s.cancelled) throw refusal("debugger_cancelled", "The owner cancelled the browser's debugging banner on this tab; quiet input is off for it until re-enabled");
      if (s.attached) return s;
      listen();
      try {
        await api.debugger.attach({ tabId }, PROTOCOL);
      } catch (error) {
        const text = String(error && error.message || error);
        if (/already attached|another debugger/i.test(text)) throw refusal("devtools_open", "DevTools or another extension is already debugging this tab");
        if (/cannot (attach|access)|chrome:|extension|not allowed|web store/i.test(text)) throw refusal("restricted_page", "Chrome does not allow debugging this kind of page");
        throw refusal("tab_not_attachable", `Could not attach to the tab: ${text.slice(0, 120)}`);
      }
      s.attached = true;
      // A covered or unfocused window reports itself hidden and then renders no frames, which stalls wheel input.
      await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
      return s;
    }

    // One action at a time per tab: the broker already serialises agents, this protects against overlapping calls.
    function run(tabId, work) {
      const s = session(tabId);
      const next = s.queue.then(async () => {
        try {
          await ensureAttached(tabId);
          if (s.timer !== null) { clearTimer(s.timer); s.timer = null; }
          return await work();
        } catch (error) {
          // Input commands are not safe to replay: Chrome may have applied the
          // click/text before its reply was lost. Fail truthfully and leave any
          // retry decision to the caller instead of duplicating a side effect.
          if (error && !error.code && /not attached|detached|no target with given id/i.test(String(error.message))) {
            s.attached = false;
            throw refusal("input_outcome_unknown", "Chrome disconnected during browser input; the action may have landed. M9R did not replay it to avoid duplicating the action");
          }
          throw error;
        } finally {
          if (s.attached) scheduleDetach(tabId);
        }
      });
      s.queue = next.catch(() => undefined);
      return next;
    }

    const finite = (n) => typeof n === "number" && Number.isFinite(n);

    function click(tabId, request) {
      const { x, y } = request || {};
      if (!finite(x) || !finite(y) || x < 0 || y < 0) return Promise.reject(refusal("bad_coordinates", "The click point is not a valid viewport coordinate"));
      const button = request.button === "right" ? "right" : request.button === "middle" ? "middle" : "left";
      const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
      const count = request.clickCount === 2 ? 2 : 1;
      return run(tabId, async () => {
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (let c = 1; c <= count; c += 1) {
          // Recheck the live tab, grant, and target after the cursor reaches the
          // page and immediately before each press. A redirect or target swap
          // during cursor travel must cancel the click.
          if (typeof request.beforePress === "function") await request.beforePress();
          try {
            await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: c });
          } catch (error) {
            // The press may have reached Chrome even if its reply was lost.
            // Release is safe cleanup; a second press would duplicate the action.
            await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c }).catch(() => undefined);
            throw error;
          }
          try {
            await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c });
          } catch (error) {
            // Best-effort release only; never repeat the press if Chrome loses
            // its reply after the click may already have taken effect.
            await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c }).catch(() => undefined);
            throw error;
          }
        }
        return { route: "quiet", trusted: true };
      });
    }

    function insertText(tabId, text) {
      if (typeof text !== "string") return Promise.reject(refusal("bad_text", "Text to insert must be a string"));
      return run(tabId, async () => {
        await send(tabId, "Input.insertText", { text });
        return { route: "quiet", trusted: true };
      });
    }

    // chrome.debugger only exists once the optional permission is granted, so the worker must start without it and listen later.
    let listening = false;
    function listen() {
      if (listening || !api.debugger || !api.debugger.onDetach) return;
      listening = true;
      api.debugger.onDetach.addListener((source, reason) => {
        const tabId = source && source.tabId;
        const s = sessions.get(tabId);
        if (!s) return;
        if (s.timer !== null) { clearTimer(s.timer); s.timer = null; }
        s.attached = false;
        if (reason === "canceled_by_user") s.cancelled = true;
        if (reason === "target_closed") sessions.delete(tabId);
      });
    }
    listen();

    if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.addListener((tabId) => { sessions.delete(tabId); });

    /** Detach anything this worker attached earlier (a worker restart loses its in-memory state). */
    async function adoptAndRelease() {
      let targets = [];
      try { targets = await api.debugger.getTargets(); } catch { return 0; }
      let released = 0;
      for (const target of targets) {
        if (target.attached && target.extensionId === (api.runtime && api.runtime.id) && Number.isSafeInteger(target.tabId)) {
          try { await api.debugger.detach({ tabId: target.tabId }); released += 1; } catch { /* already gone */ }
        }
      }
      return released;
    }

    async function closeAll() {
      await Promise.all([...sessions.keys()].map((tabId) => detach(tabId)));
    }

    async function stopAll() {
      const tabIds = [...sessions.keys()];
      for (const tabId of tabIds) session(tabId).stopped = true;
      await Promise.all(tabIds.map((tabId) => detach(tabId)));
    }

    function resumeAll() {
      for (const s of sessions.values()) s.stopped = false;
    }

    /** Owner re-enables a tab after cancelling the banner. */
    function reset(tabId) { const s = sessions.get(tabId); if (s) s.cancelled = false; }

    return { click, insertText, detach, closeAll, stopAll, resumeAll, adoptAndRelease, reset, _sessions: sessions };
  }

  root.M9RQuietInput = { create, IDLE_DETACH_MS, ALLOWED_METHODS: [...ALLOWED] };
})(globalThis);
