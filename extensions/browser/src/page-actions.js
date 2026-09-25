// Each function is serialized into the page by chrome.scripting.executeScript, so it must not use anything outside itself.

function m9rPageRead(selector, expectOrigin, expectPathPrefix) {
  try {
    const el = selector ? document.querySelector(selector) : document.body;
    if (!el) return { ok: false, error: "no element matches " + selector };
    const isInput = el instanceof HTMLInputElement;
    const isTextArea = el instanceof HTMLTextAreaElement;
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
    const text = isInput || isTextArea ? el.value : el.innerText || el.textContent || "";
    return { ok: true, data: String(text).trim().slice(0, 4000) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function m9rPageClick(selector, expectOrigin, expectPathPrefix) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: "no element matches " + selector };
    if (el.disabled || (typeof el.matches === "function" && el.matches(":disabled"))) {
      return { ok: false, error: "element is disabled" };
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return { ok: false, error: "element is not visible" };
    }
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, error: "element has no visible area" };
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit || (hit !== el && !el.contains(hit))) return { ok: false, error: "element is obscured" };
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    el.click();
    return { ok: true, data: { clicked: true } };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function m9rPageType(selector, text, expectOrigin, expectPathPrefix) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: "no element matches " + selector };
    const isInput = el instanceof HTMLInputElement;
    const isTextArea = el instanceof HTMLTextAreaElement;
    if (isInput || isTextArea) {
      const type = isInput ? String(el.type || "").toLowerCase() : "";
      const autocomplete = String(el.getAttribute("autocomplete") || "").trim().toLowerCase().split(/\s+/);
      if (type === "hidden" || type === "password" || autocomplete.some((value) =>
        value.startsWith("cc-") || value === "one-time-code" || value === "current-password" || value === "new-password")) {
        return { ok: false, error: "sensitive fields are off limits" };
      }
    }
    if (!isInput && !isTextArea && !el.isContentEditable) return { ok: false, error: "element is not a text field" };
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (expectOrigin && location.origin !== expectOrigin) return { ok: false, error: "page origin does not match the granted site" };
    if (expectPathPrefix && !(expectPathPrefix === "/" || location.pathname === expectPathPrefix || location.pathname.startsWith(expectPathPrefix.endsWith("/") ? expectPathPrefix : expectPathPrefix + "/"))) {
      return { ok: false, error: "page path does not match the granted path" };
    }
    if (isInput || isTextArea) {
      const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, data: { typed: text.length } };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}
