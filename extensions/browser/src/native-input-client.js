// Chrome MV3 service-worker client for M9R's trusted desktop input host.
// Requests fail closed; callers must never substitute synthetic page events.
(function installM9rNativeInputClient(root) {
  const POINTER_ARRIVAL_SETTLE_MS = 50;
  const POINTER_ARRIVAL_TIMEOUT_MS = 1000;

  function nowMs() {
    return root.performance && typeof root.performance.now === "function"
      ? root.performance.now()
      : Date.now();
  }

  function elapsedMs(start, end) {
    return Math.round(Math.max(0, end - start) * 100) / 100;
  }

  function create(runtime, timeoutMs = 5000) {
    const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 300000) : 5000;
    let port = null;
    const pending = new Map();

    function cleanup(item) {
      clearTimeout(item.timer);
      clearTimeout(item.arrivalTimer);
      if (item.signal && item.onAbort) {
        try { item.signal.removeEventListener("abort", item.onAbort); } catch { /* cleanup must not block request rejection */ }
      }
    }

    function rejectPending(error) {
      for (const [requestId, item] of pending) {
        pending.delete(requestId);
        cleanup(item);
        item.reject(new Error(error || "M9R native input host disconnected"));
      }
    }

    function disconnect(error) {
      port = null;
      rejectPending(error);
    }

    function closePort() {
      const current = port;
      port = null;
      if (current) {
        try { current.disconnect(); } catch { /* the host may already be gone */ }
      }
    }

    function abortRequest(requestId, error) {
      const item = pending.get(requestId);
      if (!item) return;
      pending.delete(requestId);
      cleanup(item);
      item.reject(error);
      closePort();
      rejectPending("M9R trusted input connection closed to cancel the active click");
    }

    function connect() {
      if (port) return port;
      let candidate;
      try {
        candidate = runtime.connectNative("com.m9r.native_input");
      } catch (error) {
        throw new Error(`M9R trusted input is unavailable: ${String(error && error.message || error)}`);
      }
      if (!candidate || !candidate.onMessage || !candidate.onDisconnect || typeof candidate.postMessage !== "function") {
        try { if (candidate) candidate.disconnect(); } catch { /* already disconnected */ }
        throw new Error("M9R trusted input host did not create a Native Messaging connection");
      }
      port = candidate;
      candidate.onMessage.addListener((message) => {
        if (!message || typeof message.requestId !== "string") return;
        const item = pending.get(message.requestId);
        if (!item) return;
        if (message.type === "progress") {
          if (!Number.isFinite(message.x) || !Number.isFinite(message.y)
            || message.x < 0 || message.x >= item.viewportWidth
            || message.y < 0 || message.y >= item.viewportHeight) {
            abortRequest(message.requestId, new Error("M9R native input returned invalid pointer progress; click cancelled"));
            return;
          }
          const arrived = message.phase === "arrived";
          if (arrived) item.arrivedAtMs = nowMs();
          let observed;
          try { observed = item.onProgress && item.onProgress(message); } catch (error) {
            abortRequest(message.requestId, new Error(`M9R visible pointer update failed; click cancelled: ${String(error && error.message || error)}`));
            return;
          }
          const observation = Promise.resolve(observed);
          if (!arrived) {
            observation.catch((error) => {
              abortRequest(message.requestId, new Error(`M9R visible pointer update failed; click cancelled: ${String(error && error.message || error)}`));
            });
            return;
          }
          if (!Number.isSafeInteger(message.sequence) || message.sequence < 1 || item.arrivalSequence !== undefined) {
            abortRequest(message.requestId, new Error("M9R native input returned an invalid pointer-arrival sequence; click cancelled"));
            return;
          }
          item.arrivalSequence = message.sequence;
          item.arrivalTimer = setTimeout(() => {
            abortRequest(message.requestId, new Error("M9R visible pointer did not acknowledge arrival; click cancelled"));
          }, Math.min(requestTimeoutMs, POINTER_ARRIVAL_TIMEOUT_MS));
          observation.then((result) => {
            if (!result || result.painted !== true) throw new Error("visible cursor did not confirm its rendered arrival");
            return new Promise((resolve) => setTimeout(resolve, POINTER_ARRIVAL_SETTLE_MS));
          }).then(async () => {
            if (pending.get(message.requestId) !== item || port !== candidate) return false;
            const validated = await item.beforeMouseDown(message);
            if (validated !== true) throw new Error("pre-mousedown safety validation refused the click");
            return true;
          }).then(() => {
            if (pending.get(message.requestId) !== item || port !== candidate) return;
            clearTimeout(item.arrivalTimer);
            item.arrivalTimer = null;
            item.acknowledgedAtMs = nowMs();
            candidate.postMessage({ type: "progressAck", requestId: message.requestId, sequence: message.sequence });
          }).catch((error) => {
            abortRequest(message.requestId, new Error(`M9R visible pointer arrival failed; click cancelled: ${String(error && error.message || error)}`));
          });
          return;
        }
        if (message.type !== "result") return;
        const completedAtMs = nowMs();
        if (message.ok === true && (!Number.isSafeInteger(item.arrivalSequence)
          || message.arrivalSequence !== item.arrivalSequence)) {
          abortRequest(message.requestId, new Error("M9R native host completed a click without acknowledged cursor arrival"));
          return;
        }
        pending.delete(message.requestId);
        cleanup(item);
        if (message.ok === true) {
          item.resolve({
            ...message,
            timingMs: {
              totalMs: elapsedMs(item.startedAtMs, completedAtMs),
              arrivalToAckMs: elapsedMs(item.arrivedAtMs, item.acknowledgedAtMs),
              ackToResultMs: elapsedMs(item.acknowledgedAtMs, completedAtMs),
            },
          });
        }
        else item.reject(new Error(typeof message.error === "string" ? message.error : "M9R native input was refused"));
      });
      candidate.onDisconnect.addListener(() => {
        const reason = runtime.lastError && runtime.lastError.message;
        if (port === candidate) disconnect(reason || "M9R trusted input host disconnected");
      });
      return candidate;
    }

    return Object.freeze({
      click(request, onProgress, options = {}) {
        if (!request || typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId)) {
          return Promise.reject(new Error("invalid trusted-click request identity"));
        }
        if (pending.has(request.requestId)) return Promise.reject(new Error("duplicate trusted-click request identity"));
        if (pending.size) return Promise.reject(new Error("another trusted click is already in progress"));
        const { x, y, viewportWidth, viewportHeight, button, clickCount } = request;
        if (![x, y, viewportWidth, viewportHeight].every(Number.isFinite)
          || viewportWidth < 1 || viewportWidth > 16384 || viewportHeight < 1 || viewportHeight > 16384
          || x < 0 || x >= viewportWidth || y < 0 || y >= viewportHeight
          || !["left", "right", "middle"].includes(button)
          || ![1, 2].includes(clickCount) || (button !== "left" && clickCount !== 1)) {
          return Promise.reject(new Error("invalid trusted-click coordinates or button"));
        }
        if (typeof onProgress !== "function") {
          return Promise.reject(new Error("trusted click requires a visible pointer progress handler"));
        }
        const beforeMouseDown = options && options.beforeMouseDown;
        if (typeof beforeMouseDown !== "function") {
          return Promise.reject(new Error("trusted click requires a pre-mousedown safety validator"));
        }
        const signal = options && options.signal;
        if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
          return Promise.reject(new Error("invalid trusted-click cancellation signal"));
        }
        if (signal && signal.aborted) {
          const error = new Error("M9R trusted click was cancelled; no synthetic click was attempted");
          error.name = "AbortError";
          return Promise.reject(error);
        }
        const startedAtMs = nowMs();
        let active;
        try { active = connect(); } catch (error) { return Promise.reject(error); }
        return new Promise((resolve, reject) => {
          const item = {
            resolve,
            reject,
            startedAtMs,
            timer: null,
            arrivalTimer: null,
            onProgress,
            beforeMouseDown,
            signal,
            onAbort: null,
            viewportWidth,
            viewportHeight,
          };
          item.timer = setTimeout(() => {
            abortRequest(request.requestId, new Error("M9R trusted click timed out; no synthetic click was attempted"));
          }, requestTimeoutMs);
          pending.set(request.requestId, item);
          if (signal) {
            item.onAbort = () => {
              const error = new Error("M9R trusted click was cancelled; no synthetic click was attempted");
              error.name = "AbortError";
              abortRequest(request.requestId, error);
            };
            try { signal.addEventListener("abort", item.onAbort, { once: true }); } catch (error) {
              abortRequest(request.requestId, new Error(`could not register trusted-click cancellation: ${String(error && error.message || error)}`));
              return;
            }
            if (signal.aborted) {
              item.onAbort();
              return;
            }
          }
          try {
            active.postMessage({ type: "click", requestId: request.requestId, x, y, viewportWidth, viewportHeight, button, clickCount });
          } catch (error) {
            abortRequest(request.requestId, new Error(`M9R trusted click could not be sent: ${String(error && error.message || error)}`));
          }
        });
      },
      close() {
        const current = port;
        port = null;
        if (current) {
          try { current.disconnect(); } catch { /* the host may already be gone */ }
        }
        disconnect("M9R trusted input client closed");
      },
      pendingCount() { return pending.size; },
    });
  }

  root.M9RNativeInputClient = Object.freeze({ create });
})(globalThis);
