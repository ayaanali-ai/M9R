(function (global) {
  "use strict";

  const MESSAGE_TTL_MS = 4000;
  const MAX_MESSAGES = 12;

  function clean(value, limit) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function formatPresenceMessage(input, now) {
    if (!input || typeof input !== "object") return null;
    const agent = clean(input.agent, 64);
    const provider = clean(input.provider, 40) || "agent";
    // Deliberately read only these status fields. Page values, typed text, and DOM content are never rendered here.
    const message = clean(input.message, 120) || clean(input.action, 120);
    if (!agent || !message) return null;
    const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : now;
    const id = clean(input.messageId, 128) || clean(input.id, 128) || `${agent}:${provider}:${createdAt}:${message}`;
    const claimMs = Number.isFinite(input.claimMs) ? Math.min(Math.max(input.claimMs, 0), 60000) : 0;
    const target = input.target && typeof input.target.selector === "string"
      ? { selector: clean(input.target.selector, 500) }
      : null;
    return { id, agent, provider, message, claimed: input.claimed === true, blocked: input.blocked === true, claimMs, target, createdAt, expiresAt: createdAt + MESSAGE_TTL_MS };
  }

  function createPresenceFeed() {
    const entries = [];
    const seen = new Set();
    function prune(now) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].expiresAt <= now) {
          seen.delete(entries[i].id);
          entries.splice(i, 1);
        }
      }
    }
    return {
      add(input, now) {
        const item = formatPresenceMessage(input, now);
        if (!item) return null;
        prune(now);
        if (seen.has(item.id)) return null;
        seen.add(item.id);
        entries.unshift(item);
        while (entries.length > MAX_MESSAGES) seen.delete(entries.pop().id);
        return { ...item };
      },
      list(now) {
        prune(now);
        return entries.map((item) => ({ ...item }));
      },
    };
  }

  global.M9RPresenceLogic = { MESSAGE_TTL_MS, MAX_MESSAGES, formatPresenceMessage, createPresenceFeed };
})(typeof window !== "undefined" ? window : globalThis);
