(function (global) {
  "use strict";

  function normalizeOrigin(value) {
    try {
      const parsed = new URL(value);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  function permissionPattern(value) {
    const origin = normalizeOrigin(value);
    return origin ? `${origin}/*` : null;
  }

  function pathWithinGrant(url, prefix) {
    if (!prefix) return true;
    try {
      const path = new URL(url).pathname;
      return prefix === "/" || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
    } catch {
      return false;
    }
  }

  function mayActOnUrl(url, expectedOrigin, grantedPatterns, pathPrefix) {
    const origin = normalizeOrigin(url);
    if (!origin || (expectedOrigin && origin !== expectedOrigin)) return false;
    const required = permissionPattern(origin);
    return Array.isArray(grantedPatterns) && grantedPatterns.includes(required) && pathWithinGrant(url, pathPrefix);
  }

  function normalizeApprovedGrant(value) {
    if (!value || typeof value !== "object") return null;
    const origin = normalizeOrigin(value.origin);
    const id = typeof value.grantId === "string" ? value.grantId.slice(0, 128) : "";
    if (!origin || !id) return null;
    const pathPrefix = typeof value.pathPrefix === "string" && value.pathPrefix.startsWith("/") ? value.pathPrefix.slice(0, 500) : "/";
    const actions = Array.isArray(value.actions) ? value.actions.filter((action) => ["open", "read", "click", "type"].includes(action)) : [];
    return { grantId: id, origin, pathPrefix, actions };
  }

  global.M9RPermissionLogic = { normalizeOrigin, permissionPattern, pathWithinGrant, mayActOnUrl, normalizeApprovedGrant };
})(typeof window !== "undefined" ? window : globalThis);
