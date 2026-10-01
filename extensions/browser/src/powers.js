// Page-side implementations of M9R's browser powers. m9rPagePower is serialized into the page by
// chrome.scripting.executeScript, so it must not use anything outside itself.
async function m9rPageMine(action, selector, args, expectOrigin, expectPathPrefix) {
  try {
    args = args || {};
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const refs = () => window.__m9rPageActionRefMap || (window.__m9rPageActionRefMap = new Map());
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.visibility !== "collapse" && s.display !== "none";
    };
    const resolve = (sel) => {
      if (!sel) return null;
      if (sel.startsWith("@m9r-ref:")) {
        const match = /^@m9r-ref:(e[a-f0-9]{24}_\d{1,3})$/.exec(sel);
        if (!match) return null;
        const el = refs().get(match[1]);
        return el && el.isConnected ? el : null;
      }
      try { return document.querySelector(sel); } catch { return null; }
    };
    const nameOf = (el) => {
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
      const buttonValue = el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type) ? el.value : "";
      return String(el.getAttribute("aria-label") || el.getAttribute("title") || label || el.placeholder || el.alt || buttonValue || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    };
    const roleOf = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const t = (el.type || "text").toLowerCase();
        if (t === "checkbox" || t === "radio") return t;
        if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
        if (t === "search") return "searchbox";
        return "textbox";
      }
      if (el.isContentEditable) return "textbox";
      return tag;
    };
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const mouse = (el, type, extra) => {
      const r = el.getBoundingClientRect();
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      el.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...(extra || {}) }));
    };
    const clickEl = (el) => {
      el.scrollIntoView({ block: "center" });
      mouse(el, "mousemove");
      mouse(el, "mousedown", { button: 0, buttons: 1 });
      mouse(el, "mouseup", { button: 0, buttons: 0 });
      el.click();
    };
    // Eased scrolling (minimum-jerk) so pages glide instead of jumping.
    const animateScroll = async (container, delta) => {
      if (Math.abs(delta) < 2) return;
      const duration = Math.min(1100, Math.max(320, 260 + Math.abs(delta) * 0.32));
      const start = performance.now();
      const startTop = container === window ? window.scrollY : container.scrollTop;
      await new Promise((resolve) => {
        const step = (now) => {
          const t = Math.min(1, (now - start) / duration);
          const k = t * t * t * (10 - 15 * t + 6 * t * t);
          const top = startTop + delta * k;
          if (container === window) window.scrollTo(0, top); else container.scrollTop = top;
          if (t < 1) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
    };
    const need = () => {
      const el = resolve(selector);
      if (!el) return { error: selector ? "no element matches " + selector : "this action needs a target" };
      if (el.disabled) return { error: "element is disabled" };
      if (!isVisible(el)) return { error: "element is not visible" };
      return { el };
    };
    const normalizePressKey = (value) => {
      if (typeof value !== "string" || value.length > 48) return null;
      const parts = value.split("+");
      if (parts.length < 1 || parts.length > 4 || parts.some((part) => !part)) return null;
      const aliases = { control: "control", ctrl: "control", alt: "alt", shift: "shift", meta: "meta" };
      const modifiers = new Set();
      for (const part of parts.slice(0, -1)) {
        const modifier = aliases[part.toLowerCase()];
        if (!modifier) return null;
        modifiers.add(modifier);
      }
      const rawKey = parts[parts.length - 1];
      const names = {
        enter: "Enter", return: "Enter", space: " ", tab: "Tab", escape: "Escape",
        backspace: "Backspace", delete: "Delete", arrowup: "ArrowUp", arrowdown: "ArrowDown",
        arrowleft: "ArrowLeft", arrowright: "ArrowRight", pageup: "PageUp", pagedown: "PageDown",
        home: "Home", end: "End",
      };
      const lowerKey = rawKey.toLowerCase();
      const key = names[lowerKey]
        || (/^[A-Za-z0-9]$/.test(rawKey) ? rawKey : null)
        || (/^f(?:[1-9]|1[0-2])$/i.test(rawKey) ? rawKey.toUpperCase() : null);
      return key ? { key, modifiers } : null;
    };

    if (action === "page_state") {
      const topControls = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=textbox],[role=searchbox]")].filter((el) => isVisible(el)).slice(0, 12).map((el, position) => ({ position: position + 1, role: roleOf(el), name: nameOf(el) }));
      return { ok: true, data: { url: location.href, title: document.title, topControls, visibleText: String(document.body && document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40_000) } };
    }

    if (action === "snapshot") {
      const limit = Math.max(1, Math.min(Number(args.limit) || 80, 150));
      const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const found = [];
      const seen = new Set();
      const SEL = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=textbox],[role=searchbox],[role=combobox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=''],[contenteditable=true],[onclick]";
      const collect = (root) => {
        for (const el of root.querySelectorAll(SEL)) if (!seen.has(el)) { seen.add(el); found.push(el); }
        for (const host of root.querySelectorAll("*")) if (host.shadowRoot) collect(host.shadowRoot);
      };
      collect(document);
      const vh = window.innerHeight;
      const visible = found.filter((el) => isVisible(el) && !el.closest("#m9r-presence-root"));
      const inView = visible.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; });
      const rest = visible.filter((el) => !inView.includes(el));
      const ordered = [...inView, ...rest].filter((el) => !query || (nameOf(el) + " " + roleOf(el)).toLowerCase().includes(query));
      const refPattern = /^e[a-f0-9]{24}_\d{1,3}$/;
      const existingRefs = window.__m9rPageActionRefMap;
      const map = new Map();
      if (existingRefs) {
        try {
          for (const [ref, element] of Map.prototype.entries.call(existingRefs)) {
            if (refPattern.test(ref) && element && element.isConnected !== false) map.set(ref, element);
          }
        } catch { map.clear(); }
      }
      const randomBytes = new Uint8Array(12);
      const cryptoApi = window.crypto;
      if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") return { ok: false, error: "secure snapshot refs are unavailable" };
      cryptoApi.getRandomValues(randomBytes);
      const snapshotId = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const maxTrackedRefs = 4_800;
      const lines = [];
      ordered.slice(0, limit).forEach((el, index) => {
        const id = "e" + snapshotId + "_" + (index + 1);
        map.set(id, el);
        const type = el instanceof HTMLInputElement ? (el.type || "text").toLowerCase() : "";
        const sensitive = type === "password";
        const box = rectOf(el);
        const value = !sensitive && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.value ? ' value="' + String(el.value).slice(0, 40) + '"' : "";
        const state = el.checked ? " checked" : el.disabled ? " disabled" : "";
        const link = el.tagName === "A" && el.getAttribute("href") ? " -> " + String(el.getAttribute("href")).slice(0, 80) : "";
        lines.push(id + " [" + roleOf(el) + '] "' + nameOf(el) + '"' + value + state + link + " @" + box.x + "," + box.y + " " + box.w + "x" + box.h + (index >= inView.length ? " (below the fold)" : ""));
      });
      while (map.size > maxTrackedRefs) {
        const oldestRef = map.keys().next().value;
        if (oldestRef === undefined) break;
        map.delete(oldestRef);
      }
      window.__m9rPageActionRefMap = map;
      const text = String(document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim().slice(0, 700);
      const more = ordered.length > limit ? "\n(" + (ordered.length - limit) + " more controls not shown; pass query to filter)" : "";
      return { ok: true, data: "URL: " + location.href + "\nTitle: " + document.title + "\nText: " + text + "\nControls (act by snapshot-scoped ref):\n" + (lines.join("\n") || "(none visible)") + more };
    }

    if (action === "press") {
      const key = String(args.key || "");
      const parsedKey = normalizePressKey(args.key);
      if (!parsedKey) return { ok: false, error: "press key must be one of the supported keys or shortcuts" };
      const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      let el = selector ? resolve(selector) : active;
      // Sites like Wikipedia swap the search input for a new element once it is used; the field the agent just typed in is
      // the focused one, so fall back to it when the ref went stale.
      if (selector && !el && active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) el = active;
      if (selector && !el) return { ok: false, error: "no element matches " + selector };
      if (el && selector && el !== active) el.focus();
      const target = el || document.body;
      const beforePage = { url: location.href, visibleText: String(document.body && document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40_000) };
      const norm = parsedKey.key;
      const mods = parsedKey.modifiers;
      const codes = { Enter: "Enter", Tab: "Tab", Escape: "Escape", " ": "Space", Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End" };
      const init = { key: norm, code: codes[norm] || (norm.length === 1 ? "Key" + norm.toUpperCase() : norm), bubbles: true, cancelable: true, shiftKey: !!args.shift || mods.has("shift"), ctrlKey: mods.has("control"), altKey: mods.has("alt"), metaKey: mods.has("meta") };
      const down = new KeyboardEvent("keydown", init);
      target.dispatchEvent(down);
      if (norm.length === 1 || norm === "Enter") target.dispatchEvent(new KeyboardEvent("keypress", init));
      let effect = "";
      if (!down.defaultPrevented) {
        if (norm === "Enter" && target instanceof HTMLElement) {
          const form = target.form || target.closest("form");
          const searchBox = target instanceof HTMLTextAreaElement && (target.rows <= 1 || target.name === "q" || /search/i.test(target.getAttribute("aria-label") || target.getAttribute("role") || "") || target.closest("[role=search]") !== null);
          if (searchBox && form) {
            if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit();
            effect = "submitted the search";
          } else if (searchBox) {
            const near = target.closest("[role=search]") || target.parentElement;
            const button = near && near.querySelector("button[type=submit],button[aria-label*='earch' i],input[type=submit]");
            if (button && isVisible(button)) { clickEl(button); effect = "clicked the search button"; } else { document.execCommand("insertText", false, String.fromCharCode(10)); effect = "newline"; }
          } else if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
            document.execCommand("insertText", false, "\n");
            effect = "newline";
          } else if (target instanceof HTMLInputElement && form) {
            if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit();
            effect = "submitted the form";
          } else if (target instanceof HTMLInputElement) {
            const near = target.parentElement && target.parentElement.parentElement;
            const button = near && near.querySelector("button[type=submit],button[aria-label*='earch' i],button");
            if (button && isVisible(button)) { clickEl(button); effect = "clicked the nearby search button"; }
          } else if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target.getAttribute("role") === "button") {
            clickEl(target);
            effect = "activated it";
          }
        } else if (norm === " " && target instanceof HTMLElement && (target instanceof HTMLButtonElement || target.getAttribute("role") === "button" || (target instanceof HTMLInputElement && ["checkbox", "radio", "button", "submit"].includes(target.type)))) {
          clickEl(target);
          effect = "activated it";
        } else if (norm === "Tab") {
          const list = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),textarea,select,[tabindex]")].filter((x) => !x.disabled && isVisible(x));
          const at = list.indexOf(document.activeElement);
          const next = list[(at + (init.shiftKey ? -1 : 1) + list.length) % (list.length || 1)];
          if (next) { next.focus(); effect = "moved focus"; }
        } else if (norm === "Escape") {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        }
      }
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      const afterPage = { url: location.href, visibleText: String(document.body && document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40_000) };
      const pageChanged = beforePage.url !== afterPage.url || beforePage.visibleText !== afterPage.visibleText;
      return {
        ok: true,
        data: {
          pressed: key,
          effect: effect || "sent the key",
          pageChanged,
          ...(pageChanged ? {} : { hint: `Nothing visibly changed after ${key}; check the page before retrying.` }),
        },
      };
    }

    if (action === "scroll") {
      if (selector) {
        const el = resolve(selector);
        if (!el) return { ok: false, error: "no element matches " + selector };
        const r = el.getBoundingClientRect();
        await animateScroll(window, r.top + r.height / 2 - window.innerHeight / 2);
      } else if (args.to === "top") await animateScroll(window, -window.scrollY);
      else if (args.to === "bottom") await animateScroll(window, document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
      else await animateScroll(window, Number(args.by) || 0);
      return { ok: true, data: { scrollY: Math.round(window.scrollY), of: document.documentElement.scrollHeight } };
    }

    if (action === "heal") {
      const current = window.__m9rPageActionRefMap;
      const refPattern = /^e[a-f0-9]{24}_\d{1,3}$/;
      const live = new Map();
      let staleRefsRemoved = 0;
      if (current) {
        try {
          for (const [ref, element] of Map.prototype.entries.call(current)) {
            if (refPattern.test(ref) && element && element.isConnected !== false) live.set(ref, element);
            else staleRefsRemoved += 1;
          }
        } catch { live.clear(); staleRefsRemoved = 0; }
      }
      window.__m9rPageActionRefMap = live;
      return { ok: true, data: { healed: staleRefsRemoved > 0, staleRefsRemoved } };
    }

    if (action === "ensure_visible") {
      const el = resolve(selector);
      if (!el) return { ok: true, data: { skipped: true } };
      const r = el.getBoundingClientRect();
      const margin = window.innerHeight * 0.12;
      if (r.top < margin || r.bottom > window.innerHeight - margin) await animateScroll(window, r.top + r.height / 2 - window.innerHeight / 2);
      return { ok: true, data: { visible: true } };
    }

    if (action === "wait") {
      const limit = Math.min(Number(args.ms) || (selector || args.text ? 10000 : 1000), 15000);
      const end = Date.now() + limit;
      if (!selector && !args.text) { await sleep(limit); return { ok: true, data: { waited: limit } }; }
      while (Date.now() < end) {
        if (selector && resolve(selector)) return { ok: true, data: { found: "selector" } };
        if (args.text && String(document.body ? document.body.innerText : "").includes(args.text)) return { ok: true, data: { found: "text" } };
        await sleep(200);
      }
      return { ok: false, error: "timed out waiting" };
    }

    if (action === "find") {
      const query = String(args.query || "").toLowerCase();
      if (!query) return { ok: false, error: "find needs a query" };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      let count = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = node.nodeValue || "";
        const at = value.toLowerCase().indexOf(query);
        if (at < 0 || !node.parentElement || !isVisible(node.parentElement) || node.parentElement.closest("#m9r-presence-root,script,style")) continue;
        count += 1;
        if (hits.length < 5) hits.push({ el: node.parentElement, snippet: value.slice(Math.max(0, at - 30), at + query.length + 40).replace(/\s+/g, " ").trim() });
      }
      if (args.scrollToFirst && hits[0]) hits[0].el.scrollIntoView({ block: "center" });
      return { ok: true, data: { matches: count, first: hits.map((h) => h.snippet) } };
    }

    if (action === "hover") { const t = need(); if (t.error) return { ok: false, error: t.error }; t.el.scrollIntoView({ block: "center" }); mouse(t.el, "mouseover"); mouse(t.el, "mouseenter"); mouse(t.el, "mousemove"); return { ok: true, data: { hovered: true } }; }
    if (action === "double_click") { const t = need(); if (t.error) return { ok: false, error: t.error }; clickEl(t.el); mouse(t.el, "mousedown", { button: 0, buttons: 1, detail: 2 }); mouse(t.el, "mouseup", { button: 0, detail: 2 }); mouse(t.el, "dblclick", { detail: 2 }); return { ok: true, data: { doubleClicked: true } }; }
    if (action === "right_click") { const t = need(); if (t.error) return { ok: false, error: t.error }; t.el.scrollIntoView({ block: "center" }); mouse(t.el, "mousedown", { button: 2, buttons: 2 }); mouse(t.el, "contextmenu", { button: 2 }); mouse(t.el, "mouseup", { button: 2 }); return { ok: true, data: { rightClicked: true } }; }

    if (action === "click_at") {
      const x = Number(args.x), y = Number(args.y);
      const el = document.elementFromPoint(x, y);
      if (!el) return { ok: false, error: "nothing is at that point" };
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      el.click();
      return { ok: true, data: { clicked: nameOf(el) || el.tagName.toLowerCase() } };
    }

    if (action === "select") {
      const t = need(); if (t.error) return { ok: false, error: t.error };
      if (!(t.el instanceof HTMLSelectElement)) return { ok: false, error: "select only works on a native dropdown" };
      const options = [...t.el.options];
      const match = args.value !== undefined ? options.find((o) => o.value === args.value) : options.find((o) => o.text.trim().toLowerCase() === String(args.option).trim().toLowerCase());
      if (!match) return { ok: false, error: "no such option; available: " + options.slice(0, 12).map((o) => o.text.trim()).join(" | ") };
      t.el.value = match.value;
      t.el.dispatchEvent(new Event("input", { bubbles: true }));
      t.el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, data: { selected: match.text.trim() } };
    }

    if (action === "check" || action === "uncheck" || action === "toggle") {
      const t = need(); if (t.error) return { ok: false, error: t.error };
      const isBox = t.el instanceof HTMLInputElement && (t.el.type === "checkbox" || t.el.type === "radio");
      if (isBox && ((action === "check" && t.el.checked) || (action === "uncheck" && !t.el.checked))) return { ok: true, data: { checked: t.el.checked, changed: false } };
      clickEl(t.el);
      return { ok: true, data: { checked: isBox ? t.el.checked : undefined, changed: true } };
    }

    if (action === "select_text") {
      const t = need(); if (t.error) return { ok: false, error: t.error };
      const range = document.createRange(); range.selectNodeContents(t.el);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { ok: true, data: { selected: String(selection).slice(0, 200) } };
    }

    if (action === "point") {
      const t = need(); if (t.error) return { ok: false, error: t.error };
      t.el.scrollIntoView({ block: "center" });
      return { ok: true, data: { pointedAt: nameOf(t.el) } };
    }

    if (action === "submit" || action === "buy" || action === "post" || action === "follow" || action === "like" || action === "dm" || action === "link") {
      const t = need(); if (t.error) return { ok: false, error: t.error };
      clickEl(t.el);
      return { ok: true, data: { done: action } };
    }

    if (action === "extract") {
      const el = selector ? resolve(selector) : document.querySelector("table") || document.querySelector("ul,ol");
      if (!el) return { ok: false, error: "no table or list found" };
      const max = Math.min(Number(args.maxRows) || 200, 500);
      if (el.tagName === "TABLE") {
        const rows = [...el.querySelectorAll("tr")].slice(0, max).map((tr) => [...tr.children].map((c) => c.innerText.replace(/\s+/g, " ").trim()));
        return { ok: true, data: JSON.stringify(rows) };
      }
      return { ok: true, data: JSON.stringify([...el.querySelectorAll("li")].slice(0, max).map((li) => li.innerText.replace(/\s+/g, " ").trim())) };
    }

    return { ok: false, error: action + " is not available in this M9R build yet" };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// The plain-words name of the element an action is about to touch, read before the action so it survives navigation.
function m9rPageLabel(selector) {
  try {
    let el = null;
    if (typeof selector === "string" && selector.startsWith("@m9r-ref:")) { const map = window.__m9rPageActionRefMap; el = map && map.get(selector.slice(9)); }
    else if (selector) el = document.querySelector(selector);
    if (!el) return { ok: false };
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
    const own = isField ? "" : (el.innerText || el.textContent || "");
    const buttonValue = el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) ? el.value : "";
    return { ok: true, data: String(el.getAttribute("aria-label") || el.getAttribute("title") || label || el.placeholder || el.alt || buttonValue || own || "").replace(/\s+/g, " ").trim().slice(0, 80) };
  } catch { return { ok: false }; }
}
