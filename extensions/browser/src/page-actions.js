// Each function is serialized into the page by chrome.scripting.executeScript, so it must not use anything outside itself.

async function m9rPageRead(selector, expectOrigin, expectPathPrefix) {
  try {
    const resolveOnce = () => {
      if (typeof selector === "string" && selector.startsWith("@m9r-ref:")) {
        const match = /^@m9r-ref:([A-Za-z0-9_-]{1,16})$/.exec(selector);
        const refs = window.__m9rPageActionRefMap;
        if (!match || !refs) return { fatal: "invalid page element ref" };
        const refId = match[1];
        const found = typeof refs.get === "function" ? refs.get(refId) : Object.prototype.hasOwnProperty.call(refs, refId) ? refs[refId] : null;
        if (!found || typeof found !== "object" || found.isConnected === false) return { fatal: "invalid page element ref" };
        return { el: found };
      }
      return { el: selector ? document.querySelector(selector) : document.body };
    };
    let el = null;
    // Sites with virtualized feeds (X, infinite scroll) can momentarily not have the target rendered yet, or
    // detach and re-render it, between when the agent snapshotted it and when this read actually runs. A few
    // short retries covers that gap here, in the page, instead of costing the agent a whole extra turn -- a
    // full process spin-up for Codex -- just to re-snapshot and try again. Bounded to under 300ms total so a
    // selector that will genuinely never match still fails fast.
    const RETRY_DELAYS_MS = [40, 80, 160];
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const found = resolveOnce();
      if (found.fatal) return { ok: false, error: found.fatal };
      if (found.el) { el = found.el; break; }
      if (attempt < RETRY_DELAYS_MS.length) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
    if (!el) return { ok: false, error: "no element matches " + selector };
    const isInput = String(el.tagName || "").toUpperCase() === "INPUT" || (typeof HTMLInputElement === "function" && el instanceof HTMLInputElement);
    const isTextArea = String(el.tagName || "").toUpperCase() === "TEXTAREA" || (typeof HTMLTextAreaElement === "function" && el instanceof HTMLTextAreaElement);
    if (isInput || isTextArea) {
      const type = isInput ? String(el.type || "").toLowerCase() : "";
      const autocomplete = String(el.getAttribute("autocomplete") || "").trim().toLowerCase().split(/\s+/);
      if (type === "hidden" || type === "password" || autocomplete.some((value) =>
        value.startsWith("cc-") || value === "one-time-code" || value === "current-password" || value === "new-password")) {
        return { ok: false, error: "sensitive fields are off limits" };
      }
    }
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    let text = isInput || isTextArea ? el.value : el.innerText || el.textContent || "";
    // A whole-page read also includes the text of same-origin frames (embedded widgets, editors), labelled so they are not confused with the page.
    if (!selector && !isInput && !isTextArea) {
      for (const frame of Array.from(document.querySelectorAll("iframe")).slice(0, 6)) {
        try {
          const inner = frame.contentDocument && frame.contentDocument.body ? String(frame.contentDocument.body.innerText || "").trim() : "";
          if (inner) text += " | [frame] " + inner.slice(0, 800);
        } catch { /* a cross-origin frame cannot be read */ }
      }
    }
    return { ok: true, data: String(text).trim().slice(0, 4000) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// With `live`, the click is a person's: the pointer enters, drifts onto a point inside the element (not its exact center), presses,
// holds a beat and releases. A promise is returned; without `live` the events are dispatched at once.
// Prepare a real desktop click. This validates the current page, element, hit target, and visible viewport but
// deliberately dispatches no DOM event; the extension worker sends the returned point to the Native Messaging host.
function m9rPageClickPlan(selector, expectOrigin, expectPathPrefix, requestedX, requestedY, button, clickCount, action) {
  try {
    const allowedPage = () => (!expectOrigin || location.origin === expectOrigin)
      && (!expectPathPrefix || expectPathPrefix === "/" || location.pathname === expectPathPrefix
        || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"));
    if (!allowedPage()) return { ok: false, error: "page origin or path does not match the granted site" };
    const view = window;
    const viewportWidth = Number(view.innerWidth || 0);
    const viewportHeight = Number(view.innerHeight || 0);
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth < 1 || viewportHeight < 1
      || viewportWidth > 16384 || viewportHeight > 16384) return { ok: false, error: "the visible page viewport is unavailable" };
    const allowedButton = ["left", "right", "middle"].includes(button) ? button : "left";
    const count = Number(clickCount);
    if (![1, 2].includes(count) || (allowedButton !== "left" && count !== 1)) return { ok: false, error: "unsupported click count" };
    let target = null;
    let x;
    let y;
    const reachesTargetAt = (pointX, pointY) => {
      const hit = document.elementFromPoint(pointX, pointY);
      let reaches = !!hit && (hit === target || target.contains(hit));
      for (let root = target && target.getRootNode && target.getRootNode(); !reaches && root && root.host; root = root.host.getRootNode && root.host.getRootNode()) {
        reaches = hit === root.host || !!hit && root.host.contains(hit);
      }
      return reaches;
    };
    const coordinateClick = requestedX !== null && requestedX !== undefined && requestedY !== null && requestedY !== undefined
      && Number.isFinite(Number(requestedX)) && Number.isFinite(Number(requestedY));
    if (coordinateClick) {
      x = Number(requestedX);
      y = Number(requestedY);
      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) return { ok: false, error: "click point is outside the visible page" };
      target = document.elementFromPoint(x, y);
      if (!target) return { ok: false, error: "no element at those viewport coordinates" };
    } else {
      if (typeof selector === "string" && selector.startsWith("@m9r-ref:")) {
        const match = /^@m9r-ref:([A-Za-z0-9_-]{1,16})$/.exec(selector);
        const refs = window.__m9rPageActionRefMap;
        target = match && refs && typeof refs.get === "function" ? refs.get(match[1]) : null;
        if (!target || target.isConnected === false) return { ok: false, error: "invalid or stale page element ref" };
      } else {
        try { target = document.querySelector(selector); } catch { return { ok: false, error: "invalid click selector" }; }
      }
      if (!target) return { ok: false, error: "no element matches " + selector };
      if (action === "submit") {
        const tag = String(target.tagName || "").toUpperCase();
        if (tag === "FORM") {
          target = target.querySelector('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]');
          if (!target) return { ok: false, error: "form has no visible submit control to click" };
        } else if (!(tag === "BUTTON" && String(target.type || "submit").toLowerCase() === "submit")
          && !(tag === "INPUT" && ["submit", "image"].includes(String(target.type || "").toLowerCase()))) {
          return { ok: false, error: "submit target must be a real submit button or form" };
        }
      }
      if (target.disabled || (typeof target.matches === "function" && target.matches(":disabled"))) return { ok: false, error: "element is disabled" };
      const style = getComputedStyle(target);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return { ok: false, error: "element is not visible" };
      target.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, error: "element has no visible area" };
      const fragments = typeof target.getClientRects === "function" ? Array.from(target.getClientRects()) : [];
      const visibleRects = (fragments.length ? fragments : [rect]).map((fragment) => ({
        left: Math.max(0, fragment.left),
        right: Math.min(viewportWidth, Number.isFinite(fragment.right) ? fragment.right : fragment.left + fragment.width),
        top: Math.max(0, fragment.top),
        bottom: Math.min(viewportHeight, Number.isFinite(fragment.bottom) ? fragment.bottom : fragment.top + fragment.height),
      })).filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
      if (visibleRects.length === 0) return { ok: false, error: "element is outside the visible page" };
      // Inline elements can wrap across lines. Their bounding rectangle includes empty space
      // between fragments, so sample bounded points from the actual rendered fragments and only
      // accept one whose hit-test still reaches the requested control.
      let foundTargetPoint = false;
      const attempts = Math.max(16, Math.min(64, visibleRects.length * 8));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const fragment = visibleRects[Math.floor(Math.random() * visibleRects.length)];
        const candidateX = fragment.left + (fragment.right - fragment.left) * (0.2 + Math.random() * 0.6);
        const candidateY = fragment.top + (fragment.bottom - fragment.top) * (0.2 + Math.random() * 0.6);
        if (reachesTargetAt(candidateX, candidateY)) {
          x = candidateX;
          y = candidateY;
          foundTargetPoint = true;
          break;
        }
      }
      if (!foundTargetPoint) return { ok: false, error: "element is obscured" };
    }
    if (coordinateClick && !reachesTargetAt(x, y)) return { ok: false, error: "element is obscured" };
    if (!allowedPage()) return { ok: false, error: "page origin or path changed while preparing the click" };
    const rect = target.getBoundingClientRect();
    return { ok: true, data: {
      x, y, viewportWidth, viewportHeight, button: allowedButton, clickCount: count,
      name: String(target.getAttribute && (target.getAttribute("aria-label") || target.getAttribute("title")) || target.innerText || target.textContent || target.tagName || "")
        .replace(/\s+/g, " ").trim().slice(0, 160),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
    } };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function m9rPageClick(selector, expectOrigin, expectPathPrefix, live) {
  try {
    let el;
    if (typeof selector === "string" && selector.startsWith("@m9r-ref:")) {
      const match = /^@m9r-ref:([A-Za-z0-9_-]{1,16})$/.exec(selector);
      const refs = window.__m9rPageActionRefMap;
      if (!match || !refs) return { ok: false, error: "invalid page element ref" };
      const refId = match[1];
      el = typeof refs.get === "function" ? refs.get(refId) : Object.prototype.hasOwnProperty.call(refs, refId) ? refs[refId] : null;
      if (!el || typeof el !== "object" || el.isConnected === false) return { ok: false, error: "invalid page element ref" };
    } else {
      el = document.querySelector(selector);
    }
    if (!el) return { ok: false, error: "no element matches " + selector };
    if (el.disabled || (typeof el.matches === "function" && el.matches(":disabled"))) {
      return { ok: false, error: "element is disabled" };
    }
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return { ok: false, error: "element is not visible" };
    }
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, error: "element has no visible area" };
    const pageDoc = el.ownerDocument || document;
    const hit = pageDoc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    // A control inside a shadow root is reported by elementFromPoint as its host, so any host on the way up counts as the element itself.
    const reachesHit = () => {
      if (!hit) return false;
      if (hit === el || el.contains(hit)) return true;
      for (let root = el.getRootNode && el.getRootNode(); root && root.host; root = root.host.getRootNode && root.host.getRootNode()) {
        if (root.host === hit || root.host.contains(hit)) return true;
      }
      return false;
    };
    if (!reachesHit()) return { ok: false, error: "element is obscured" };
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    if (live && typeof MouseEvent === "function") {
      const view = pageDoc.defaultView || window;
      // This function is injected alone (chrome.scripting.executeScript with `func:`), so it cannot import or call a
      // helper defined elsewhere in this file -- m9rGlideAndClick in m9rPagePower below is a deliberate duplicate, not
      // a copy-paste accident, and the two must be kept in sync by hand.
      return (async () => {
        const Mouse = view.MouseEvent || MouseEvent;
        const Pointer = typeof (view.PointerEvent || (typeof PointerEvent !== "undefined" ? PointerEvent : undefined)) === "function" ? (view.PointerEvent || PointerEvent) : null;
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const endX = rect.left + rect.width * (0.3 + Math.random() * 0.4);
        const endY = rect.top + rect.height * (0.3 + Math.random() * 0.4);
        const previous = window.__m9rLastActionPoint;
        const nearby = previous && Math.hypot(endX - previous.x, endY - previous.y) < 48;
        const skipGlide = document.hidden === true || nearby;
        // A real cursor can be arriving from any direction, not always the upper-left -- a fixed approach vector is
        // exactly the kind of repeatable signature a site watching for automation would learn to spot.
        const angle = Math.random() * Math.PI * 2;
        const dist = 110 + Math.random() * 260;
        const startX = endX + Math.cos(angle) * dist;
        const startY = endY + Math.sin(angle) * dist;
        const travelled = Math.hypot(endX - startX, endY - startY);
        // Same shape as the on-screen cursor's own glide duration (presence-overlay.js glideDuration): distance-scaled,
        // not a fixed short window regardless of how far the pointer has to travel.
        const duration = Math.min(650, Math.max(120, 110 + 75 * Math.log2(1 + travelled / 30)));
        const steps = Math.max(5, Math.min(14, Math.round(duration / 26)));
        const overshoot = Math.random() < 0.22;
        const fire = (Type, type, x, y, buttons) => el.dispatchEvent(new Type(type, { bubbles: true, cancelable: true, view, button: 0, buttons, clientX: x, clientY: y, ...(Type === Pointer ? { pointerId: 1, pointerType: "mouse", isPrimary: true } : {}) }));
        if (Pointer) { fire(Pointer, "pointerover", startX, startY, 0); fire(Pointer, "pointerenter", startX, startY, 0); }
        fire(Mouse, "mouseover", startX, startY, 0);
        for (let i = 1; i <= steps && !skipGlide; i += 1) {
          const t = i / steps;
          const ease = t * t * t * (t * (t * 6 - 15) + 10); // quintic minimum-jerk, matches the overlay's cursor
          let x = startX + (endX - startX) * ease;
          let y = startY + (endY - startY) * ease;
          // A real hand often slightly overshoots and corrects on the way in, rather than arriving on a perfect curve.
          if (overshoot && t > 0.68 && t < 0.95) {
            const bump = 1 - Math.abs(t - 0.82) / 0.13;
            x += (endX - startX) * 0.035 * bump;
            y += (endY - startY) * 0.035 * bump;
          }
          if (Pointer) fire(Pointer, "pointermove", x, y, 0);
          fire(Mouse, "mousemove", x, y, 0);
          await wait((duration / steps) * (0.55 + Math.random() * 0.8));
        }
        if (Pointer) fire(Pointer, "pointermove", endX, endY, 0);
        fire(Mouse, "mousemove", endX, endY, 0);
        window.__m9rLastActionPoint = { x: endX, y: endY };
        if (!skipGlide) await wait(20 + Math.random() * 35);
        if (Pointer) fire(Pointer, "pointerdown", endX, endY, 1);
        fire(Mouse, "mousedown", endX, endY, 1);
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        await wait(20 + Math.random() * 35);
        if (Pointer) fire(Pointer, "pointerup", endX, endY, 0);
        fire(Mouse, "mouseup", endX, endY, 0);
        el.click();
        return { ok: true, data: { clicked: true } };
      })().catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
    }
    if (typeof MouseEvent === "function") {
      const view = pageDoc.defaultView || window;
      const Mouse = view.MouseEvent || MouseEvent;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      el.dispatchEvent(new Mouse("mousemove", { bubbles: true, cancelable: true, view, clientX: centerX, clientY: centerY }));
      el.dispatchEvent(new Mouse("mousedown", { bubbles: true, cancelable: true, view, button: 0, buttons: 1, clientX: centerX, clientY: centerY }));
      el.dispatchEvent(new Mouse("mouseup", { bubbles: true, cancelable: true, view, button: 0, buttons: 0, clientX: centerX, clientY: centerY }));
    }
    el.click();
    return { ok: true, data: { clicked: true } };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// With `live`, the text goes in one character at a time (so the owner sees it being typed) and a promise is returned;
// the typing is capped at about two seconds, after which the rest of the value is set at once.
function m9rPageType(selector, text, expectOrigin, expectPathPrefix, live) {
  try {
    let el;
    if (typeof selector === "string" && selector.startsWith("@m9r-ref:")) {
      const match = /^@m9r-ref:([A-Za-z0-9_-]{1,16})$/.exec(selector);
      const refs = window.__m9rPageActionRefMap;
      if (!match || !refs) return { ok: false, error: "invalid page element ref" };
      const refId = match[1];
      el = typeof refs.get === "function" ? refs.get(refId) : Object.prototype.hasOwnProperty.call(refs, refId) ? refs[refId] : null;
      if (!el || typeof el !== "object" || el.isConnected === false) return { ok: false, error: "invalid page element ref" };
    } else {
      el = document.querySelector(selector);
    }
    if (!el) return { ok: false, error: "no element matches " + selector };
    const isInput = String(el.tagName || "").toUpperCase() === "INPUT" || (typeof HTMLInputElement === "function" && el instanceof HTMLInputElement);
    const isTextArea = String(el.tagName || "").toUpperCase() === "TEXTAREA" || (typeof HTMLTextAreaElement === "function" && el instanceof HTMLTextAreaElement);
    if (isInput || isTextArea) {
      const type = isInput ? String(el.type || "").toLowerCase() : "";
      const autocomplete = String(el.getAttribute("autocomplete") || "").trim().toLowerCase().split(/\s+/);
      if (type === "hidden" || type === "password" || autocomplete.some((value) =>
        value.startsWith("cc-") || value === "one-time-code" || value === "current-password" || value === "new-password")) {
        return { ok: false, error: "sensitive fields are off limits" };
      }
    }
    if (!isInput && !isTextArea && !el.isContentEditable) return { ok: false, error: "element is not a text field" };
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || (typeof window !== "undefined" ? window : globalThis);
    const setter = isInput || isTextArea
      ? Object.getOwnPropertyDescriptor(isTextArea ? (view.HTMLTextAreaElement || HTMLTextAreaElement).prototype : (view.HTMLInputElement || HTMLInputElement).prototype, "value").set
      : null;
    const put = (value) => { if (setter) setter.call(el, value); else el.textContent = value; };
    const readValue = () => isInput || isTextArea ? String(el.value || "") : String(el.textContent || "");
    const sendInput = (data, inputType) => {
      const eventView = doc.defaultView || (typeof window !== "undefined" ? window : globalThis);
      const EventType = eventView.InputEvent || (typeof InputEvent !== "undefined" ? InputEvent : Event);
      el.dispatchEvent(new EventType("input", { bubbles: true, cancelable: false, inputType, data }));
    };
    const insertWithCommand = (value) => {
      if (typeof doc.execCommand !== "function") return false;
      try {
        if ((isInput || isTextArea) && typeof el.setSelectionRange === "function") el.setSelectionRange(0, readValue().length);
        else if (el.isContentEditable && doc.getSelection && doc.createRange) {
          const selection = doc.getSelection();
          const range = doc.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const didInsert = doc.execCommand("insertText", false, value);
        if (didInsert && readValue() === String(value)) return true;
      } catch {
        // Browsers and editor frameworks vary; use the value-setter fallback below.
      }
      return false;
    };
    if (live) {
      return (async () => {
        const chars = Array.from(String(text));
        const started = Date.now();
        let typed = "";
        put("");
        sendInput("", "deleteContentBackward");
        // A person's rhythm: a beat before the first key, log-normal gaps between keys, longer after a space or punctuation,
        // the odd hesitation. Long text is sped up to fit the time budget, and whatever is left is then set at once.
        const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
        const budgetMs = Math.min(1400, Math.max(450, chars.length * 3));
        // Keep short text visibly key-by-key, but do not make a long task spend
        // several seconds animating hundreds of characters. The tail is inserted
        // through the same guarded value path after a representative prefix.
        const animatedChars = chars.length > 220 ? chars.slice(0, 80) : chars;
        const pace = Math.min(1, budgetMs / Math.max(1, animatedChars.length * 30));
        const gap = (ch) => {
          let ms = Math.exp(Math.log(42) + 0.35 * gauss());
          if (ch === " ") ms += 40 + Math.random() * 100;
          else if (/[.,;:!?]/.test(ch)) ms += 60 + Math.random() * 120;
          if (Math.random() < 0.04) ms += 250 + Math.random() * 250;
          return Math.max(8, ms * pace);
        };
        await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 50));
        for (const ch of animatedChars) {
          if (Date.now() - started > budgetMs || !el.isConnected) break;
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: /^[a-z]$/i.test(ch) ? "Key" + ch.toUpperCase() : /^[0-9]$/.test(ch) ? "Digit" + ch : ch === " " ? "Space" : "", bubbles: true, cancelable: true }));
          let inserted = false;
          if ((isInput || isTextArea) && typeof el.setSelectionRange === "function") el.setSelectionRange(typed.length, typed.length);
          if (typeof doc.execCommand === "function") {
            try { inserted = doc.execCommand("insertText", false, ch) === true; } catch { inserted = false; }
          }
          if (inserted) typed = readValue();
          else { typed += ch; put(typed); sendInput(ch, "insertText"); }
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, gap(ch)));
        }
        if (typed !== text) {
          if (!insertWithCommand(String(text))) {
            put(text);
            sendInput(String(text), "insertReplacementText");
          }
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, data: { typed: text.length } };
      })().catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
    }
    if (!insertWithCommand(String(text))) {
      put(text);
      sendInput(String(text), "insertText");
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, data: { typed: text.length } };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function m9rPageSnapshot(query, requestedLimit) {
  try {
    const limit = Math.min(150, Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : 150));
    const filter = typeof query === "string" ? query.trim().toLowerCase() : "";
    const refs = new Map();
    const elements = [];
    const keyText = String(document.body && (document.body.innerText || document.body.textContent) || "").trim().slice(0, 3000);
    const interactive = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/;
    const roleSet = new Set(["button", "link", "checkbox", "radio", "switch", "combobox", "menuitem", "tab", "option", "textbox", "searchbox"]);
    const sensitive = (el) => {
      const type = String(el.type || "").toLowerCase();
      const autocomplete = String(el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      return type === "password" || type === "hidden" || autocomplete.some((value) => value.startsWith("cc-") || ["one-time-code", "current-password", "new-password"].includes(value));
    };
    const visible = (el, doc) => {
      try {
        const view = doc.defaultView || window;
        const style = view.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(rect.width) > 0 && Number(rect.height) > 0;
      } catch { return false; }
    };
    const rectInTopViewport = (el, doc) => {
      const rect = el.getBoundingClientRect();
      let x = rect.left;
      let y = rect.top;
      let view = doc.defaultView;
      try {
        while (view && view !== view.top) {
          const frame = view.frameElement;
          if (!frame) break;
          const frameRect = frame.getBoundingClientRect();
          x += frameRect.left;
          y += frameRect.top;
          view = view.parent;
        }
      } catch { /* Cross-origin frames are intentionally not traversed. */ }
      return { x: Math.round(x), y: Math.round(y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const accessibleName = (el) => {
      const attr = (name) => String(el.getAttribute && el.getAttribute(name) || "").trim();
      let label = attr("aria-label") || attr("title") || attr("placeholder");
      const doc = el.ownerDocument || document;
      if (!label && el.id && doc.querySelector) {
        try { const node = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`); label = node && (node.innerText || node.textContent); } catch { /* Ignore malformed identifiers. */ }
      }
      if (!label && el.labels && el.labels.length) label = Array.from(el.labels).map((node) => node.innerText || node.textContent || "").join(" ");
      if (!label) label = el.innerText || el.textContent || attr("name") || String(el.tagName || "").toLowerCase();
      return String(label).replace(/\s+/g, " ").trim().slice(0, 160);
    };
    const visit = (root, doc) => {
      if (!root || elements.length >= limit) return;
      const children = root.children ? Array.from(root.children) : root.body ? [root.body] : root.documentElement ? [root.documentElement] : [];
      for (const el of children) {
        if (elements.length >= limit) break;
        const tag = String(el.tagName || "").toUpperCase();
        const role = String(el.getAttribute && el.getAttribute("role") || "").toLowerCase();
        const isControl = interactive.test(tag) || roleSet.has(role) || el.isContentEditable === true || String(el.getAttribute && el.getAttribute("contenteditable")) === "true";
        if (isControl && visible(el, doc) && !sensitive(el)) {
          const name = accessibleName(el);
          const description = `${name} ${role} ${tag}`.toLowerCase();
          if (!filter || description.includes(filter)) {
            const ref = `e${elements.length + 1}`;
            refs.set(ref, el);
            const rect = rectInTopViewport(el, doc);
            elements.push({ ref, role: role || tag.toLowerCase(), name, rect, disabled: el.disabled === true, sensitive: sensitive(el) });
          }
        }
        if (el.shadowRoot && el.shadowRoot.mode !== "closed") visit(el.shadowRoot, doc);
        if (tag === "IFRAME" || tag === "FRAME") {
          try { if (el.contentDocument) visit(el.contentDocument, el.contentDocument); } catch { /* Same-origin only. */ }
        }
        visit(el, doc);
      }
    };
    visit(document, document);
    window.__m9rPageActionRefMap = refs;
    return { ok: true, data: { url: location.href, title: document.title || "", text: keyText, elements } };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function m9rPagePower(action, selector, args, expectOrigin, expectPathPrefix, endSelector, text, targetLabel) {
  try {
    const allowedPage = () => !expectOrigin || location.origin === expectOrigin
      ? (!expectPathPrefix || expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))
      : false;
    const resolve = (value) => {
      if (typeof value !== "string" || !value) return null;
      if (value.startsWith("@m9r-ref:")) {
        const match = /^@m9r-ref:([A-Za-z0-9_-]{1,16})$/.exec(value);
        const map = window.__m9rPageActionRefMap;
        const element = match && map && typeof map.get === "function" ? map.get(match[1]) : null;
        return element && element.isConnected !== false ? element : null;
      }
      try { return document.querySelector(value); } catch { return null; }
    };
    const sensitive = (el) => {
      const type = String(el && el.type || "").toLowerCase();
      const autocomplete = String(el && el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      return type === "hidden" || type === "password" || autocomplete.some((value) => value.startsWith("cc-") || ["one-time-code", "current-password", "new-password"].includes(value));
    };
    const info = (el) => {
      if (!el) return null;
      const doc = el.ownerDocument || document;
      const rect = el.getBoundingClientRect();
      let x = rect.left; let y = rect.top; let view = doc.defaultView;
      try { while (view && view !== view.top) { const frame = view.frameElement; if (!frame) break; const fr = frame.getBoundingClientRect(); x += fr.left; y += fr.top; view = view.parent; } } catch { /* Cross-origin. */ }
      const name = String(el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || el.innerText || el.textContent || el.tagName || "").replace(/\s+/g, " ").trim().slice(0, 160);
      const segments = [];
      let node = el;
      while (node && node.nodeType === 1 && segments.length < 6) {
        const tag = String(node.tagName || "div").toLowerCase();
        if (node.id) {
          const css = (doc.defaultView && doc.defaultView.CSS) || (typeof CSS !== "undefined" ? CSS : null);
          if (css && typeof css.escape === "function") segments.unshift(`#${css.escape(node.id)}`);
          else segments.unshift(`${tag}[id="${String(node.id).replace(/"/g, "\\\"")}"]`);
          break;
        }
        let segment = tag;
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        segments.unshift(segment);
        node = parent;
      }
      return { rect: { x: Math.round(x), y: Math.round(y), width: Math.round(rect.width), height: Math.round(rect.height) }, name, selector: segments.join(" > ") || null };
    };
    const target = action === "click_at" ? document.elementFromPoint(Number(args.x), Number(args.y)) : resolve(selector);
    const doc = target && target.ownerDocument || document;
    if (action === "target_at") {
      const element = doc.elementFromPoint(Number(args.x), Number(args.y));
      if (!element) return { ok: false, error: "no element at those viewport coordinates" };
      return { ok: true, data: info(element) };
    }
    if (action === "target" || action === "point" || action === "link") {
      if (selector && !target) return { ok: false, error: "the snapshot ref or selector is stale; take a new snapshot" };
      if (!allowedPage()) return { ok: false, error: "page origin or path does not match the granted site" };
      if (action === "link") {
        const href = target && target.href;
        if (typeof href !== "string" || !/^https?:/i.test(href)) return { ok: false, error: "the target does not contain a safe HTTP(S) link" };
        return { ok: true, data: { href, ...info(target) } };
      }
      if (target && !info(target).rect.width) return { ok: false, error: "target has no visible area" };
      return { ok: true, data: target ? info(target) : { rect: { x: 0, y: 0, width: Number(window.innerWidth || 0), height: Number(window.innerHeight || 0) }, name: "page" } };
    }
    if (action === "wait") {
      const waitMs = Math.min(15000, Math.max(0, Number(args.ms || 0)));
      return (async () => {
        const deadline = Date.now() + waitMs;
        do {
          if (!allowedPage()) return { ok: false, error: "page origin or path changed while waiting" };
          if (selector && resolve(selector)) return { ok: true, data: { found: true } };
          if (args.text && String(document.body && document.body.innerText || "").includes(args.text)) return { ok: true, data: { found: true } };
          if (!selector && !args.text && Date.now() >= deadline) return { ok: true, data: { waitedMs: waitMs } };
          if (Date.now() >= deadline) break;
          await new Promise((done) => setTimeout(done, 100));
        } while (true);
        return { ok: false, error: "wait condition did not appear before the timeout" };
      })();
    }
    if (action === "back" || action === "forward") {
      if (!allowedPage()) return { ok: false, error: "page origin or path does not match the grant" };
      if (action === "back") history.back(); else history.forward();
      return { ok: true, data: { navigated: action } };
    }
    if (action === "scroll") {
      if (!allowedPage()) return { ok: false, error: "page origin or path does not match the grant" };
      const amount = Number(args.by || 0);
      if (target) {
        target.scrollIntoView({ behavior: args.smooth ? "smooth" : "instant", block: "center" });
      } else if (args.to === "top" || args.to === "bottom") {
        window.scrollTo({ top: args.to === "top" ? 0 : document.documentElement.scrollHeight, behavior: args.smooth ? "smooth" : "instant" });
      } else window.scrollBy({ top: amount, behavior: args.smooth ? "smooth" : "instant" });
      return { ok: true, data: { scrolled: true, target: target ? info(target) : null } };
    }
    if (action === "find") {
      const query = String(args.query || "").trim().toLowerCase();
      if (!query) return { ok: false, error: "find needs a text query" };
      const matches = Array.from(document.querySelectorAll("body *")).filter((el) => {
        const value = String(el.innerText || "").replace(/\s+/g, " ").trim();
        const style = getComputedStyle(el);
        return value && value.length <= 500 && value.toLowerCase().includes(query) && style.display !== "none" && style.visibility !== "hidden";
      }).slice(0, 20).map((el) => ({ text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300), ...info(el) }));
      if (args.scrollToFirst && matches.length) { const first = Array.from(document.querySelectorAll("body *")).find((el) => String(el.innerText || "").toLowerCase().includes(query)); if (first) first.scrollIntoView({ block: "center" }); }
      return { ok: true, data: { matches } };
    }
    if (action === "extract") {
      if (!target) return { ok: false, error: "no table or list matches the target" };
      const max = Math.min(500, Math.max(1, Number(args.maxRows || 100)));
      if (String(target.tagName).toUpperCase() === "TABLE") {
        const rows = Array.from(target.querySelectorAll("tr")).slice(0, max).map((row) => Array.from(row.querySelectorAll("th,td")).slice(0, 50).map((cell) => String(cell.innerText || cell.textContent || "").trim().slice(0, 500)));
        return { ok: true, data: { kind: "table", rows } };
      }
      if (["UL", "OL"].includes(String(target.tagName).toUpperCase())) return { ok: true, data: { kind: "list", items: Array.from(target.querySelectorAll(":scope > li")).slice(0, max).map((item) => String(item.innerText || item.textContent || "").trim().slice(0, 500)) } };
      return { ok: false, error: "target is not a table or list" };
    }
    if (action === "copy" && !selector) {
      const selection = document.getSelection && document.getSelection();
      return { ok: true, data: { text: String(selection && selection.toString() || "").slice(0, 5000), clipboard: "not written" } };
    }
    if (action === "fill_form") {
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before filling form" };
      const values = Array.isArray(args.fields) ? args.fields : [];
      for (const field of values) {
        const input = resolve(field.selector);
        if (!input || sensitive(input)) return { ok: false, error: "form contains a missing or sensitive field" };
        const inputView = (input.ownerDocument || document).defaultView || window;
        const tag = String(input.tagName).toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA") return { ok: false, error: "form target is not a text field" };
        const proto = tag === "TEXTAREA" ? (inputView.HTMLTextAreaElement || HTMLTextAreaElement).prototype : (inputView.HTMLInputElement || HTMLInputElement).prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (!setter) return { ok: false, error: "field cannot be safely filled" };
        setter.call(input, field.value);
        input.dispatchEvent(new (inputView.InputEvent || InputEvent)("input", { bubbles: true, inputType: "insertText", data: field.value }));
        input.dispatchEvent(new (inputView.Event || Event)("change", { bubbles: true }));
      }
      return { ok: true, data: { filled: values.length } };
    }
    if (!target) return { ok: false, error: "the snapshot ref or selector is stale; take a new snapshot" };
    if (sensitive(target) && ["type", "paste", "fill_form", "select", "check", "uncheck", "toggle", "copy", "upload"].includes(action)) return { ok: false, error: "sensitive fields are off limits" };
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: "target has no visible area" };
    const view = doc.defaultView || window;
    const dispatchMouse = (el, type, x, y, button = 0, detail = 1) => {
      const Mouse = view.MouseEvent || MouseEvent;
      el.dispatchEvent(new Mouse(type, { bubbles: true, cancelable: true, view, clientX: x, clientY: y, button, buttons: type === "mousedown" ? 1 : 0, detail }));
    };
    // This function is injected alone via chrome.scripting.executeScript's `func:`, so it cannot call the glide helper
    // written inside m9rPageClick above -- that copy is a deliberate duplicate, not an accident, and the two must be
    // kept in sync by hand. Without this, click_at/double_click/right_click/hover dispatched dead-center with no
    // movement at all, a far more obvious automation signature than the plain click path ever had.
    const glideTo = async (endX, endY) => {
      const Mouse = view.MouseEvent || MouseEvent;
      const Pointer = typeof (view.PointerEvent || (typeof PointerEvent !== "undefined" ? PointerEvent : undefined)) === "function" ? (view.PointerEvent || PointerEvent) : null;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const angle = Math.random() * Math.PI * 2;
      const dist = 110 + Math.random() * 260;
      const startX = endX + Math.cos(angle) * dist;
      const startY = endY + Math.sin(angle) * dist;
      const travelled = Math.hypot(endX - startX, endY - startY);
      const duration = Math.min(650, Math.max(120, 110 + 75 * Math.log2(1 + travelled / 30)));
      const steps = Math.max(5, Math.min(14, Math.round(duration / 26)));
      const previous = window.__m9rLastActionPoint;
      const skipGlide = document.hidden === true || (previous && Math.hypot(endX - previous.x, endY - previous.y) < 48);
      const overshoot = Math.random() < 0.22;
      for (let i = 1; i <= steps && !skipGlide; i += 1) {
        const t = i / steps;
        const ease = t * t * t * (t * (t * 6 - 15) + 10);
        let x = startX + (endX - startX) * ease;
        let y = startY + (endY - startY) * ease;
        if (overshoot && t > 0.68 && t < 0.95) {
          const bump = 1 - Math.abs(t - 0.82) / 0.13;
          x += (endX - startX) * 0.035 * bump;
          y += (endY - startY) * 0.035 * bump;
        }
        const hovered = doc.elementFromPoint(x, y);
        if (hovered) {
          if (Pointer) hovered.dispatchEvent(new Pointer("pointermove", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y }));
          hovered.dispatchEvent(new Mouse("mousemove", { bubbles: true, cancelable: true, view, clientX: x, clientY: y }));
        }
        await wait((duration / steps) * (0.55 + Math.random() * 0.8));
      }
      window.__m9rLastActionPoint = { x: endX, y: endY };
      if (!skipGlide) await wait(20 + Math.random() * 35);
    };
    const clickSafely = async (el, button = 0, count = 1) => {
      if (el.disabled || el.matches(":disabled")) throw new Error("target is disabled");
      const style = view.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") throw new Error("target is not visible");
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      const x = box.left + box.width * (0.3 + Math.random() * 0.4);
      const y = box.top + box.height * (0.3 + Math.random() * 0.4);
      const hit = doc.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) throw new Error("target is obscured");
      if (!allowedPage()) throw new Error("page origin or path changed before the action");
      await glideTo(x, y);
      if (!allowedPage()) throw new Error("page origin or path changed before the action");
      for (let i = 0; i < count; i++) {
        dispatchMouse(el, "mousemove", x, y, button, count);
        dispatchMouse(el, "mousedown", x, y, button, count);
        dispatchMouse(el, "mouseup", x, y, button, count);
        if (button === 0) el.click();
        else el.dispatchEvent(new (view.MouseEvent || MouseEvent)("contextmenu", { bubbles: true, cancelable: true, button }));
      }
    };
    if (["click", "click_at", "download", "submit", "buy", "post", "follow", "like", "dm"].includes(action)) {
      if (action === "click_at") {
        const at = doc.elementFromPoint(Number(args.x), Number(args.y));
        if (!at) return { ok: false, error: "no element at those viewport coordinates" };
        await clickSafely(at, args.button === "right" ? 2 : args.button === "middle" ? 1 : 0);
        return { ok: true, data: { clicked: true, target: info(at) } };
      }
      if (action === "submit") {
        const form = String(target.tagName).toUpperCase() === "FORM" ? target : target.form;
        if (form && typeof form.requestSubmit === "function") { if (!allowedPage()) return { ok: false, error: "page origin or path changed before submit" }; form.requestSubmit(target instanceof (view.HTMLButtonElement || HTMLButtonElement) || (target.type === "submit" || target.type === "image") ? target : undefined); return { ok: true, data: { submitted: true, target: info(target) } }; }
      }
      await clickSafely(target);
      return { ok: true, data: { clicked: true, target: info(target) } };
    }
    if (action === "double_click" || action === "right_click") {
      await clickSafely(target, action === "right_click" ? 2 : 0, action === "double_click" ? 2 : 1);
      if (action === "double_click") target.dispatchEvent(new (view.MouseEvent || MouseEvent)("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
      return { ok: true, data: { action, target: info(target) } };
    }
    if (action === "hover") { if (!allowedPage()) return { ok: false, error: "page origin or path changed before hover" }; const Pointer = (target.ownerDocument.defaultView || window).PointerEvent;
      const r = target.getBoundingClientRect();
      const hx = r.left + r.width * (0.3 + Math.random() * 0.4), hy = r.top + r.height * (0.3 + Math.random() * 0.4);
      await glideTo(hx, hy);
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before hover" };
      // A person moving onto a control enters it (pointer, then mouse events) and then moves inside it; menus listen for either.
      for (const type of ["pointerover", "pointerenter"]) if (typeof Pointer === "function") target.dispatchEvent(new Pointer(type, { bubbles: type === "pointerover", cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: hx, clientY: hy }));
      dispatchMouse(target, "mouseover", hx, hy); dispatchMouse(target, "mouseenter", hx, hy);
      if (typeof Pointer === "function") target.dispatchEvent(new Pointer("pointermove", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: hx, clientY: hy }));
      dispatchMouse(target, "mousemove", hx, hy); return { ok: true, data: { hovered: true, target: info(target) } }; }
    if (action === "drag" || action === "drop") {
      const destination = action === "drag" ? resolve(endSelector || args.destination) : target;
      const source = action === "drag" ? target : target;
      if (!destination) return { ok: false, error: "drag destination is missing or stale" };
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before drag" };
      const DataTransferType = view.DataTransfer || (typeof DataTransfer === "function" ? DataTransfer : null);
      if (!DataTransferType) return { ok: false, error: "this browser does not support page drag data" };
      const transfer = new DataTransferType();
      if (args.mime && typeof args.data === "string") transfer.setData(args.mime, args.data);
      { const b = source.getBoundingClientRect(); dispatchMouse(source, "dragstart", b.left + b.width / 2, b.top + b.height / 2); }
      destination.dispatchEvent(new (view.DragEvent || DragEvent)("dragenter", { bubbles: true, dataTransfer: transfer }));
      destination.dispatchEvent(new (view.DragEvent || DragEvent)("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      destination.dispatchEvent(new (view.DragEvent || DragEvent)("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return { ok: true, data: { dispatched: true, source: info(source), target: info(destination), trusted: false } };
    }
    if (["check", "uncheck", "toggle"].includes(action)) {
      if (!/^(checkbox|radio)$/i.test(String(target.type || "")) && String(target.getAttribute && target.getAttribute("role") || "") !== "switch") return { ok: false, error: "target is not a checkbox, radio, or switch" };
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before form action" };
      target.checked = action === "toggle" ? !target.checked : action === "check";
      target.dispatchEvent(new (view.Event || Event)("input", { bubbles: true })); target.dispatchEvent(new (view.Event || Event)("change", { bubbles: true }));
      return { ok: true, data: { checked: target.checked, target: info(target) } };
    }
    if (action === "select") {
      if (String(target.tagName).toUpperCase() !== "SELECT") return { ok: false, error: "target is not a native select control" };
      const option = args.value !== undefined ? Array.from(target.options).find((item) => item.value === args.value) : Array.from(target.options).find((item) => item.textContent.trim() === args.option);
      if (!option) return { ok: false, error: "select option was not found" };
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before selecting" };
      target.value = option.value; target.dispatchEvent(new (view.Event || Event)("input", { bubbles: true })); target.dispatchEvent(new (view.Event || Event)("change", { bubbles: true }));
      return { ok: true, data: { selected: option.textContent.trim(), target: info(target) } };
    }
    if (action === "press") {
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before keypress" };
      target.focus();
      const key = String(args.key || "");
      const KeyEvent = view.KeyboardEvent || KeyboardEvent;
      target.dispatchEvent(new KeyEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: args.shift === true }));
      target.dispatchEvent(new KeyEvent("keyup", { key, bubbles: true, cancelable: true, shiftKey: args.shift === true }));
      return { ok: true, data: { pressed: key, target: info(target), trusted: false } };
    }
    if (action === "fill_form") {
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before filling form" };
      const values = Array.isArray(args.fields) ? args.fields : [];
      for (const field of values) {
        const input = resolve(field.selector);
        if (!input || sensitive(input)) return { ok: false, error: "form contains a missing or sensitive field" };
        const inputView = (input.ownerDocument || document).defaultView || window;
        const proto = String(input.tagName).toUpperCase() === "TEXTAREA" ? inputView.HTMLTextAreaElement.prototype : inputView.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (!setter) return { ok: false, error: "field cannot be safely filled" };
        setter.call(input, field.value);
        input.dispatchEvent(new (inputView.InputEvent || InputEvent)("input", { bubbles: true, inputType: "insertText", data: field.value }));
        input.dispatchEvent(new (inputView.Event || Event)("change", { bubbles: true }));
      }
      return { ok: true, data: { filled: values.length } };
    }
    if (action === "select_text") {
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before selecting text" };
      const content = String(target.innerText || target.textContent || ""); const start = content.indexOf(String(args.text || text || ""));
      if (start < 0) return { ok: false, error: "requested text is not inside the target" };
      if (!doc.createRange || !doc.getSelection) return { ok: false, error: "text selection is not available in this frame" };
      const range = doc.createRange(); range.setStart(target.firstChild || target, start); range.setEnd(target.firstChild || target, start + String(args.text || text).length);
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { ok: true, data: { selected: String(args.text || text).length } };
    }
    if (action === "copy") {
      if (sensitive(target)) return { ok: false, error: "sensitive fields are off limits" };
      const selection = doc.getSelection();
      const value = String(target.value !== undefined ? target.value.slice(target.selectionStart || 0, target.selectionEnd || target.value.length) : selection && selection.toString() || target.innerText || target.textContent || "");
      return { ok: true, data: { text: value.slice(0, 5000), clipboard: "not written" } };
    }
    if (action === "paste" || action === "type") {
      const field = target;
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before text insertion" };
      const value = String(action === "paste" ? args.valueText || "" : text || "");
      field.focus();
      if (!allowedPage()) return { ok: false, error: "page origin or path changed after focusing" };
      const fieldView = (field.ownerDocument || document).defaultView || window;
      const fieldIsEditable = field.isContentEditable === true;
      const input = String(field.tagName).toUpperCase() === "INPUT"; const textarea = String(field.tagName).toUpperCase() === "TEXTAREA";
      if (!input && !textarea && !fieldIsEditable) return { ok: false, error: "target is not an editable field" };
      if (fieldIsEditable) { field.focus(); }
      const commandDoc = field.ownerDocument || document;
      let inserted = false;
      if (typeof commandDoc.execCommand === "function") { try { inserted = commandDoc.execCommand("insertText", false, value) === true; } catch { inserted = false; } }
      if (!inserted) {
        const proto = textarea ? (fieldView.HTMLTextAreaElement || HTMLTextAreaElement).prototype : (fieldView.HTMLInputElement || HTMLInputElement).prototype;
        const setter = (input || textarea) && Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(field, value); else field.textContent = value;
      }
      field.dispatchEvent(new (fieldView.InputEvent || InputEvent)("input", { bubbles: true, inputType: "insertText", data: value }));
      return { ok: true, data: { inserted: value.length } };
    }
    if (action === "upload") {
      if (String(target.type).toLowerCase() !== "file") return { ok: false, error: "upload target must be a file input" };
      if (!allowedPage()) return { ok: false, error: "page origin or path changed before opening file picker" };
      target.click(); return { ok: true, data: { openedPicker: true, ownerMustChooseFile: true } };
    }
    return { ok: false, error: `unsupported page action ${action}` };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// Runs in the page itself. A native alert, confirm or prompt freezes the page and every script call after it, so while an agent works
// they are answered safely (alert closes, confirm says no, prompt is cancelled) and recorded so the agent can be told about them.
function m9rPageDialogGuard(drain) {
  const w = window;
  if (!w.__m9rDialogGuard) {
    w.__m9rDialogGuard = true;
    w.__m9rDialogs = [];
    const note = (kind, text, result) => { w.__m9rDialogs.push({ kind, text: String(text == null ? "" : text).slice(0, 200), answered: result === undefined ? "closed" : result === false ? "no" : "cancelled" }); return result; };
    w.alert = (text) => { note("alert", text, undefined); };
    w.confirm = (text) => note("confirm", text, false);
    w.prompt = (text) => note("prompt", text, null);
  }
  return drain ? w.__m9rDialogs.splice(0) : [];
}
