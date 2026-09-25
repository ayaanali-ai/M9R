(function (global) {
  "use strict";

  const ROOT_ID = "m9r-presence-root";
  const TRAIL_MAX = 8;
  const IDLE_AFTER_MS = 15000;
  const EDGE = 10;
  const MESSAGE_TTL_MS = 4000;
  const FEED_LIMIT = 12;

  const HIDDEN_SESSIONS_KEY = "m9rHiddenMessageSessions";

  const ARROW =
    '<svg viewBox="0 0 16 16"><path d="M1 1l5 13 2.2-5.3L13.5 6.5z" fill="var(--c)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  const STYLE = `
    .layer{position:fixed;inset:0;pointer-events:none;font:500 11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif}
    .agent{position:absolute;left:0;top:0;will-change:transform;transition:transform 480ms cubic-bezier(.22,.8,.3,1),opacity 300ms}
    .agent.instant{transition:opacity 300ms}
    .agent.idle{opacity:.45}
    .agent.offscreen .badge{outline:2px dashed rgba(255,255,255,.75);outline-offset:2px}
    .agent.flip-x .badge{left:-37px}
    .agent.flip-x .label{left:auto;right:42px}
    .agent.flip-y .badge{top:-37px}
    .agent.flip-y .label{top:-32px}
    .arrow{position:absolute;left:0;top:0;width:16px;height:16px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
    .badge{position:absolute;left:11px;top:11px;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#fff;background:var(--c);font:700 12px/1 system-ui,sans-serif;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.28)}
    .provider-logo{width:16px;height:16px;object-fit:contain;display:block;filter:brightness(0) invert(1)}.who-agent .provider-logo{width:14px;height:14px}.who-agent{display:inline-flex;align-items:center;gap:6px}.who-agent.logo-only{width:28px;height:28px;padding:0;justify-content:center;border-radius:50%}.who-agent.logo-only .provider-logo{width:16px;height:16px}.provider-fallback{font:700 12px/1 system-ui,sans-serif}
    .label{position:absolute;left:42px;top:16px;white-space:nowrap;padding:3px 8px;border-radius:999px;background:rgba(18,18,22,.88);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:220px;overflow:hidden;text-overflow:ellipsis}
    .label:empty{display:none}
    .lock{position:absolute;right:-17px;top:-5px;display:none;padding:2px 4px;border:1px solid #fff;border-radius:4px;background:#a32222;color:#fff;font:700 8px/1 system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3)}
    .agent.claimed .lock{display:block}
    .bubble{position:absolute;left:42px;top:40px;max-width:240px;padding:6px 9px;border:1px solid rgba(255,255,255,.7);border-radius:7px;background:rgba(18,18,22,.94);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.32);opacity:1;transition:opacity 350ms ease;white-space:normal}
    .bubble:empty{display:none}.bubble.fading{opacity:0}
    .pulse{position:absolute;border:2px solid #fff;border-radius:8px;box-shadow:0 0 0 3px rgba(18,18,22,.6),0 0 18px var(--c);animation:pulse 900ms ease-out infinite}
    .rail{position:fixed;right:14px;top:14px;width:min(300px,calc(100vw - 28px));max-height:42vh;overflow:hidden;padding:8px;border:1px solid rgba(255,255,255,.55);border-radius:10px;background:rgba(18,18,22,.82);color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.24);font:12px/1.35 system-ui,sans-serif;backdrop-filter:blur(6px)}
    .rail{pointer-events:auto}
    .rail:empty{display:none}.rail-title{margin:0 0 5px;font-weight:700;letter-spacing:.03em}.entry{display:grid;grid-template-columns:22px 1fr auto;gap:6px;align-items:start;padding:5px 2px;border-top:1px solid rgba(255,255,255,.14)}
    .entry-icon{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--c);font-size:10px;font-weight:700}.entry-main{min-width:0}.entry-name{font-weight:700}.entry-message{overflow-wrap:anywhere;color:rgba(255,255,255,.88)}.entry-claim{padding:2px 4px;border-radius:4px;background:#a32222;font-size:9px;font-weight:700}.entry-blocked{background:#b45309}
    .who{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:5px;align-items:center;max-width:calc(100vw - 28px);padding:5px 8px;border:1px solid rgba(255,255,255,.5);border-radius:999px;background:rgba(18,18,22,.82);color:#fff;box-shadow:0 3px 14px rgba(0,0,0,.24);font:11px/1.2 system-ui,sans-serif;pointer-events:none;backdrop-filter:blur(6px)}
    .who:empty{display:none}.who-agent{padding:3px 7px;border-radius:999px;background:var(--c);white-space:nowrap}.who-stopped{padding:4px 7px;background:#7f1d1d;border-radius:999px;font-weight:700;white-space:nowrap}
    .message-toggle{display:block;margin:5px 0 2px 26px;padding:3px 6px;border:1px solid rgba(255,255,255,.35);border-radius:5px;background:transparent;color:#fff;font:10px/1.2 system-ui,sans-serif;cursor:pointer}
    @keyframes pulse{50%{transform:scale(1.04);opacity:.55}}
    .dot{position:absolute;width:7px;height:7px;margin:-3px 0 0 -3px;border-radius:50%;opacity:.55;animation:fade 800ms ease-out forwards}
    @keyframes fade{to{opacity:0;transform:scale(.4)}}
    @media (prefers-reduced-motion:reduce){.agent{transition:none}.dot,.pulse{display:none}}
  `;

  function pointFor(doc, target, fallback) {
    if (!target) return fallback;
    if (typeof target.selector === "string") {
      let el = null;
      try {
        el = doc.querySelector(target.selector);
      } catch {
        el = null;
      }
      if (!el) return fallback;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: target.x, y: target.y };
    return fallback;
  }

  function createPresenceOverlay(doc, options) {
    const view = doc.defaultView;
    const host = doc.createElement("div");
    host.id = ROOT_ID;
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    const layer = doc.createElement("div");
    layer.className = "layer";
    const who = doc.createElement("aside");
    who.className = "who";
    who.setAttribute("aria-label", "M9R agents on this page");
    const rail = doc.createElement("aside");
    rail.className = "rail";
    rail.setAttribute("aria-label", "Recent M9R agent activity");
    rail.setAttribute("aria-live", "polite");
    shadow.append(style, layer, who, rail);
    doc.documentElement.appendChild(host);

    const agents = new Map();
    const pulses = new Map();
    const feed = global.M9RPresenceLogic ? global.M9RPresenceLogic.createPresenceFeed() : null;
    const hiddenSessions = new Set();
    const storage = global.chrome && global.chrome.storage && global.chrome.storage.local;
    if (storage) {
      storage.get(HIDDEN_SESSIONS_KEY).then((stored) => {
        const saved = stored && stored[HIDDEN_SESSIONS_KEY];
        if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") hiddenSessions.add(id);
      }).catch(() => {});
    }
    let currentSessionId = "";
    let stoppedByOwner = "";
    let frame = 0;
    let railTimer = 0;

    function dropTrail(point, color) {
      const dot = doc.createElement("div");
      dot.className = "dot";
      dot.style.cssText = `left:${point.x}px;top:${point.y}px;background:${color}`;
      dot.addEventListener("animationend", () => dot.remove());
      layer.appendChild(dot);
      const dots = layer.querySelectorAll(".dot");
      for (let i = 0; i < dots.length - TRAIL_MAX * Math.max(1, agents.size); i++) dots[i].remove();
    }

    function place(agent, animate) {
      const vw = view.innerWidth;
      const vh = view.innerHeight;
      const raw = pointFor(doc, agent.target, agent.point || { x: vw / 2, y: vh / 2 });
      const x = Math.min(Math.max(raw.x, EDGE), vw - EDGE);
      const y = Math.min(Math.max(raw.y, EDGE), vh - EDGE);
      const moved = agent.point ? Math.hypot(x - agent.point.x, y - agent.point.y) : 0;
      if (animate && moved > 24) dropTrail(agent.point, agent.color);
      agent.el.classList.toggle("instant", !animate || !agent.point);
      agent.point = { x, y };
      agent.el.style.transform = `translate(${x}px, ${y}px)`;
      agent.el.classList.toggle("offscreen", x !== raw.x || y !== raw.y);
      agent.el.classList.toggle("flip-x", x > vw - 260);
      agent.el.classList.toggle("flip-y", y > vh - 48);
    }

    function createAgent(id, provider) {
      const spec = providerSpec(provider);
      const el = doc.createElement("div");
      el.className = "agent";
      el.style.setProperty("--c", spec.color);
      const arrow = doc.createElement("div");
      arrow.innerHTML = ARROW;
      const svg = arrow.firstChild;
      svg.setAttribute("class", "arrow");
      const badge = doc.createElement("div");
      badge.className = "badge";
      const glyph = doc.createElement("span");
      glyph.className = "provider-fallback";
      glyph.textContent = spec.glyph;
      badge.appendChild(glyph);
      const logo = providerLogo(spec);
      if (logo) {
        logo.addEventListener("load", () => { glyph.style.display = "none"; });
        badge.appendChild(logo);
      }
      const lock = doc.createElement("span");
      lock.className = "lock";
      lock.textContent = "LOCK";
      badge.appendChild(lock);
      const label = doc.createElement("div");
      label.className = "label";
      const bubble = doc.createElement("div");
      bubble.className = "bubble";
      el.append(svg, badge, label, bubble);
      layer.appendChild(el);
      const agent = { id, el, label, bubble, color: spec.color, provider: spec.label, sessionId: "", activity: "", lastMessage: "", target: null, point: null, lastSeen: Date.now(), bubbleTimer: 0, fadeTimer: 0, claimTimer: 0 };
      agents.set(id, agent);
      return agent;
    }

    function providerSpec(provider) {
      const spec = global.M9RPresenceLogic && global.M9RPresenceLogic.providerPresentation
        ? global.M9RPresenceLogic.providerPresentation(provider)
        : { label: String(provider || "Agent"), glyph: String(provider || "A").slice(0, 1).toUpperCase(), color: "#6b7280" };
      return spec;
    }

    function providerLogo(spec) {
      if (!spec.asset || !global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.getURL !== "function") return null;
      const image = doc.createElement("img");
      image.className = "provider-logo";
      image.alt = "";
      image.src = global.chrome.runtime.getURL(spec.asset);
      image.addEventListener("error", () => image.remove());
      return image;
    }

    function renderWho() {
      while (who.firstChild) who.removeChild(who.firstChild);
      const active = [...agents.values()].filter((agent) => Date.now() - agent.lastSeen <= IDLE_AFTER_MS);
      for (const agent of active) {
        const badge = doc.createElement("span");
        badge.className = "who-agent";
        badge.style.setProperty("--c", agent.color);
        const provider = providerSpec(agent.provider);
        const logo = providerLogo(provider);
        if (logo) badge.appendChild(logo);
        // The provider mark identifies the agent; only add a name when it says something the mark does not.
        const sameAsProvider = String(agent.id).toLowerCase() === String(provider.label).toLowerCase();
        if (!logo || !sameAsProvider) {
          const name = doc.createElement("span");
          name.textContent = sameAsProvider ? provider.label : String(agent.id);
          badge.appendChild(name);
        } else {
          badge.classList.add("logo-only");
        }
        badge.title = `${agent.id} · ${provider.label}${agent.activity ? " · " + agent.activity : ""}`;
        who.appendChild(badge);
      }
      if (stoppedByOwner) {
        const stopped = doc.createElement("span");
        stopped.className = "who-stopped";
        stopped.textContent = `Stopped by ${stoppedByOwner}`;
        who.appendChild(stopped);
      }
    }

    function toggleMessageText(sessionId) {
      if (!sessionId) return;
      if (hiddenSessions.has(sessionId)) hiddenSessions.delete(sessionId);
      else hiddenSessions.add(sessionId);
      if (storage) void storage.set({ [HIDDEN_SESSIONS_KEY]: [...hiddenSessions] }).catch(() => {});
      if (options && typeof options.onMessageVisibility === "function") {
        try { options.onMessageVisibility(sessionId, !hiddenSessions.has(sessionId)); } catch {}
      }
      for (const agent of agents.values()) {
        if (agent.sessionId !== sessionId) continue;
        const hidden = hiddenSessions.has(sessionId) && agent.lastMessage;
        if (hidden) {
          agent.bubble.textContent = "M9R message hidden";
          agent.label.textContent = "M9R message hidden";
        } else if (agent.lastMessage) {
          agent.bubble.textContent = agent.lastMessage;
          agent.label.textContent = agent.lastMessage;
        }
      }
      renderRail(feed ? feed.list(Date.now()) : []);
    }

    function renderRail(items) {
      while (rail.firstChild) rail.removeChild(rail.firstChild);
      if (!items.length) return;
      const title = doc.createElement("div");
      title.className = "rail-title";
      title.textContent = "AGENT ACTIVITY";
      rail.appendChild(title);
      if (currentSessionId) {
        const toggle = doc.createElement("button");
        toggle.type = "button";
        toggle.className = "message-toggle";
        toggle.textContent = hiddenSessions.has(currentSessionId) ? "Show M9R message text" : "Hide M9R message text";
        toggle.addEventListener("click", () => toggleMessageText(currentSessionId));
        rail.appendChild(toggle);
      }
      for (const item of items.slice(0, FEED_LIMIT)) {
        const spec = providerSpec(item.provider);
        const row = doc.createElement("div");
        row.className = "entry";
        row.style.setProperty("--c", spec.color);
        const icon = doc.createElement("span");
        icon.className = "entry-icon";
        const logo = providerLogo(spec);
        if (logo) icon.appendChild(logo);
        else icon.textContent = spec.glyph;
        const main = doc.createElement("span");
        main.className = "entry-main";
        const name = doc.createElement("span");
        name.className = "entry-name";
        const sameName = String(item.agent).toLowerCase() === String(spec.label).toLowerCase();
        name.textContent = item.messageKind === "agent_message" && item.recipient
          ? `${item.agent} to ${item.recipient}${sameName ? "" : " · " + spec.label}`
          : (sameName ? spec.label : `${item.agent} · ${spec.label}`);
        const message = doc.createElement("span");
        message.className = "entry-message";
        message.textContent = item.messageKind === "agent_message" && item.sessionId && hiddenSessions.has(item.sessionId)
          ? "M9R message hidden"
          : item.message;
        main.append(name, doc.createElement("br"), message);
        row.append(icon, main);
        if (item.blocked) {
          const blocked = doc.createElement("span");
          blocked.className = "entry-claim entry-blocked";
          blocked.textContent = "BLOCKED";
          row.appendChild(blocked);
        } else if (item.claimed) {
          const claim = doc.createElement("span");
          claim.className = "entry-claim";
          claim.textContent = "CLAIMED";
          row.appendChild(claim);
        }
        rail.appendChild(row);
      }
    }

    function scheduleRailExpiry(items) {
      if (railTimer) view.clearTimeout(railTimer);
      if (!feed || !items.length) return;
      const expiresAt = Math.min(...items.map((item) => item.expiresAt));
      railTimer = view.setTimeout(() => {
        const active = feed.list(Date.now());
        renderRail(active);
        scheduleRailExpiry(active);
      }, Math.max(1, expiresAt - Date.now()));
    }

    function pulseTarget(id, target, color) {
      const previous = pulses.get(id);
      if (previous) previous.remove();
      if (!target || typeof target.selector !== "string") return;
      let element = null;
      try { element = doc.querySelector(target.selector); } catch { return; }
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ring = doc.createElement("div");
      ring.className = "pulse";
      ring.style.cssText = `left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 4}px;height:${rect.height + 4}px;--c:${color}`;
      layer.appendChild(ring);
      pulses.set(id, ring);
    }

    function update(msg) {
      const id = String(msg.agent || "").slice(0, 64);
      if (!id) return;
      const agent = agents.get(id) || createAgent(id, msg.provider || id);
      agent.lastSeen = Date.now();
      agent.target = msg.target || null;
      agent.sessionId = typeof msg.sessionId === "string" ? msg.sessionId : agent.sessionId;
      if (agent.sessionId) currentSessionId = agent.sessionId;
      agent.el.classList.remove("idle");
      const summary = global.M9RPresenceLogic
        ? global.M9RPresenceLogic.formatPresenceMessage({ ...msg, agent: id }, Date.now())
        : null;
      const message = summary?.message ?? (typeof msg.action === "string" ? msg.action.slice(0, 80) : "");
      const isAgentMessage = msg.messageKind === "agent_message";
      if (isAgentMessage) agent.lastMessage = message;
      agent.activity = message;
      const hideText = isAgentMessage && (msg.showMessageText === false || (agent.sessionId && hiddenSessions.has(agent.sessionId)));
      const displayMessage = hideText ? "M9R message hidden" : message;
      agent.label.textContent = displayMessage;
      agent.el.classList.toggle("claimed", msg.claimed === true);
      if (agent.claimTimer) view.clearTimeout(agent.claimTimer);
      if (msg.claimed === true) {
        const claimMs = Math.min(Math.max(Number(msg.claimMs) || 8000, 500), 60000);
        agent.claimTimer = view.setTimeout(() => agent.el.classList.remove("claimed"), claimMs);
        pulseTarget(id, agent.target, agent.color);
      } else {
        const previous = pulses.get(id);
        if (previous) previous.remove();
        pulses.delete(id);
      }
      if (feed && summary) {
        feed.add({ ...msg, agent: id, provider: summary.provider, message: summary.message, claimed: msg.claimed === true, blocked: msg.blocked === true }, Date.now());
        const items = feed.list(Date.now());
        renderRail(items);
        scheduleRailExpiry(items);
      }
      agent.bubble.textContent = hideText ? "M9R message hidden" : summary?.bubbleMessage ?? displayMessage;
      agent.bubble.classList.remove("fading");
      if (agent.bubbleTimer) view.clearTimeout(agent.bubbleTimer);
      if (agent.fadeTimer) view.clearTimeout(agent.fadeTimer);
      agent.bubbleTimer = view.setTimeout(() => agent.bubble.classList.add("fading"), MESSAGE_TTL_MS - 350);
      agent.fadeTimer = view.setTimeout(() => { agent.bubble.textContent = ""; }, MESSAGE_TTL_MS);
      place(agent, true);
      renderWho();
    }

    function stop(owner) {
      stoppedByOwner = typeof owner === "string" && owner.trim() ? owner.trim().slice(0, 64) : "owner";
      renderWho();
    }

    function resume() {
      stoppedByOwner = "";
      renderWho();
    }

    function remove(id) {
      const agent = agents.get(id);
      if (!agent) return;
      agent.el.remove();
      if (agent.bubbleTimer) view.clearTimeout(agent.bubbleTimer);
      if (agent.fadeTimer) view.clearTimeout(agent.fadeTimer);
      if (agent.claimTimer) view.clearTimeout(agent.claimTimer);
      const pulse = pulses.get(id);
      if (pulse) pulse.remove();
      pulses.delete(id);
      agents.delete(id);
    }

    function reflow() {
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        for (const agent of agents.values()) if (agent.target && agent.target.selector) place(agent, false);
        for (const [id, pulse] of pulses) {
          const target = agents.get(id)?.target;
          if (!target?.selector) continue;
          try {
            const element = doc.querySelector(target.selector);
            const rect = element?.getBoundingClientRect();
            if (rect && rect.width && rect.height) pulse.style.cssText = `left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 4}px;height:${rect.height + 4}px;--c:${agents.get(id).color}`;
          } catch {}
        }
      });
    }

    const idleTimer = view.setInterval(() => {
      const now = Date.now();
      for (const agent of agents.values()) agent.el.classList.toggle("idle", now - agent.lastSeen > IDLE_AFTER_MS);
    }, 2000);

    view.addEventListener("scroll", reflow, { capture: true, passive: true });
    view.addEventListener("resize", reflow, { passive: true });

    function destroy() {
      view.clearInterval(idleTimer);
      if (railTimer) view.clearTimeout(railTimer);
      for (const agent of agents.values()) {
        if (agent.bubbleTimer) view.clearTimeout(agent.bubbleTimer);
        if (agent.fadeTimer) view.clearTimeout(agent.fadeTimer);
        if (agent.claimTimer) view.clearTimeout(agent.claimTimer);
      }
      view.removeEventListener("scroll", reflow, { capture: true });
      view.removeEventListener("resize", reflow);
      host.remove();
      agents.clear();
      pulses.clear();
    }

    function snapshot() {
      return [...agents.values()].map((a) => ({
        id: a.id,
        provider: a.provider,
        sessionId: a.sessionId,
        point: a.point,
        label: a.label.textContent,
        message: a.bubble.textContent,
        classes: [...a.el.classList].filter((c) => c !== "agent"),
      }));
    }

    return { update, remove, stop, resume, destroy, snapshot };
  }

  global.M9RPresence = { createPresenceOverlay, ROOT_ID };
})(typeof window !== "undefined" ? window : globalThis);
