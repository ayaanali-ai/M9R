(function (global) {
  "use strict";

  const MESSAGE_TTL_MS = 4000;
  const MAX_MESSAGES = 12;
  const PROVIDERS = {
    claude: { label: "Claude", glyph: "C", color: "#c96442", asset: "assets/providers/claude.svg" },
    "claude-code": { label: "Claude", glyph: "C", color: "#c96442", asset: "assets/providers/claude.svg" },
    codex: { label: "Codex", glyph: "X", color: "#0f9d7a", asset: "assets/providers/codex.svg" },
    "codex-cli": { label: "Codex", glyph: "X", color: "#0f9d7a", asset: "assets/providers/codex.svg" },
    opencode: { label: "OpenCode", glyph: "O", color: "#6a5acd", asset: "assets/providers/opencode.svg" },
  };

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
    const recipient = clean(input.to, 80);
    return {
      id,
      agent,
      provider,
      providerLabel: providerPresentation(provider).label,
      message,
      messageKind: input.messageKind === "agent_message" ? "agent_message" : "activity",
      sessionId: clean(input.sessionId, 128) || null,
      recipient,
      showMessageText: input.showMessageText !== false,
      claimed: input.claimed === true,
      blocked: input.blocked === true,
      claimMs,
      target,
      createdAt,
      expiresAt: createdAt + MESSAGE_TTL_MS,
    };
  }

  function providerPresentation(value) {
    const provider = clean(value, 40).toLowerCase();
    const known = PROVIDERS[provider];
    if (known) return { ...known, known: true };
    const label = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Agent";
    const glyph = Array.from(label)[0].toUpperCase();
    return { label, glyph, color: "#6b7280", asset: null, known: false };
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

  global.M9RPresenceLogic = { MESSAGE_TTL_MS, MAX_MESSAGES, formatPresenceMessage, providerPresentation, createPresenceFeed };
})(typeof window !== "undefined" ? window : globalThis);
