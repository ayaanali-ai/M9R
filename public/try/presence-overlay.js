(function (global) {
  "use strict";

  const ROOT_ID = "m9r-presence-root";
  const TRAIL_MAX = 8;
  const IDLE_AFTER_MS = 15000;
  const EDGE = 10;
  const MESSAGE_TTL_MS = 4000;
  const FEED_LIMIT = 12;

  const PROVIDERS = {
    claude: { color: "#c96442", glyph: "C" },
    codex: { color: "#0f9d7a", glyph: "X" },
    opencode: { color: "#6a5acd", glyph: "O" },
    grok: { color: "#3b3f4a", glyph: "G" },
  };
  const FALLBACK_PROVIDER = { color: "#4f6bed", glyph: "A" };

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
    .label{position:absolute;left:42px;top:16px;white-space:nowrap;padding:3px 8px;border-radius:999px;background:rgba(18,18,22,.88);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:220px;overflow:hidden;text-overflow:ellipsis}
    .label:empty{display:none}
    .lock{position:absolute;right:-17px;top:-5px;display:none;padding:2px 4px;border:1px solid #fff;border-radius:4px;background:#a32222;color:#fff;font:700 8px/1 system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3)}
    .agent.claimed .lock{display:block}
    .bubble{position:absolute;left:42px;top:40px;max-width:240px;padding:6px 9px;border:1px solid rgba(255,255,255,.7);border-radius:7px;background:rgba(18,18,22,.94);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.32);opacity:1;transition:opacity 350ms ease;white-space:normal}
    .bubble:empty{display:none}.bubble.fading{opacity:0}
    .pulse{position:absolute;border:2px solid #fff;border-radius:8px;box-shadow:0 0 0 3px rgba(18,18,22,.6),0 0 18px var(--c);animation:pulse 900ms ease-out infinite}
    .rail{position:fixed;right:14px;top:14px;width:min(300px,calc(100vw - 28px));max-height:42vh;overflow:hidden;padding:8px;border:1px solid rgba(255,255,255,.55);border-radius:10px;background:rgba(18,18,22,.82);color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.24);font:12px/1.35 system-ui,sans-serif;backdrop-filter:blur(6px)}
    .rail:empty{display:none}.rail-title{margin:0 0 5px;font-weight:700;letter-spacing:.03em}.entry{display:grid;grid-template-columns:22px 1fr auto;gap:6px;align-items:start;padding:5px 2px;border-top:1px solid rgba(255,255,255,.14)}
    .entry-icon{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--c);font-size:10px;font-weight:700}.entry-main{min-width:0}.entry-name{font-weight:700}.entry-message{overflow-wrap:anywhere;color:rgba(255,255,255,.88)}.entry-claim{padding:2px 4px;border-radius:4px;background:#a32222;font-size:9px;font-weight:700}.entry-blocked{background:#b45309}
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

  function createPresenceOverlay(doc) {
    const view = doc.defaultView;
    const host = doc.createElement("div");
    host.id = ROOT_ID;
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    const layer = doc.createElement("div");
    layer.className = "layer";
    const rail = doc.createElement("aside");
    rail.className = "rail";
    rail.setAttribute("aria-label", "Recent M9R agent activity");
    rail.setAttribute("aria-live", "polite");
    shadow.append(style, layer, rail);
    doc.documentElement.appendChild(host);

    const agents = new Map();
    const pulses = new Map();
    const feed = global.M9RPresenceLogic ? global.M9RPresenceLogic.createPresenceFeed() : null;
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
      const spec = PROVIDERS[String(provider).toLowerCase()] || FALLBACK_PROVIDER;
      const el = doc.createElement("div");
      el.className = "agent";
      el.style.setProperty("--c", spec.color);
      const arrow = doc.createElement("div");
      arrow.innerHTML = ARROW;
      const svg = arrow.firstChild;
      svg.setAttribute("class", "arrow");
      const badge = doc.createElement("div");
      badge.className = "badge";
      badge.textContent = spec.glyph;
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
      const agent = { id, el, label, bubble, color: spec.color, target: null, point: null, lastSeen: Date.now(), bubbleTimer: 0, fadeTimer: 0, claimTimer: 0 };
      agents.set(id, agent);
      return agent;
    }

    function renderRail(items) {
      while (rail.firstChild) rail.removeChild(rail.firstChild);
      if (!items.length) return;
      const title = doc.createElement("div");
      title.className = "rail-title";
      title.textContent = "AGENT ACTIVITY";
      rail.appendChild(title);
      for (const item of items.slice(0, FEED_LIMIT)) {
        const spec = PROVIDERS[String(item.provider).toLowerCase()] || FALLBACK_PROVIDER;
        const row = doc.createElement("div");
        row.className = "entry";
        row.style.setProperty("--c", spec.color);
        const icon = doc.createElement("span");
        icon.className = "entry-icon";
        icon.textContent = spec.glyph;
        const main = doc.createElement("span");
        main.className = "entry-main";
        const name = doc.createElement("span");
        name.className = "entry-name";
        name.textContent = item.agent + " · " + item.provider;
        const message = doc.createElement("span");
        message.className = "entry-message";
        message.textContent = item.message;
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
      agent.el.classList.remove("idle");
      const summary = global.M9RPresenceLogic
        ? global.M9RPresenceLogic.formatPresenceMessage({ ...msg, agent: id }, Date.now())
        : null;
      const message = summary?.message ?? (typeof msg.action === "string" ? msg.action.slice(0, 80) : "");
      agent.label.textContent = message;
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
      agent.bubble.textContent = message;
      agent.bubble.classList.remove("fading");
      if (agent.bubbleTimer) view.clearTimeout(agent.bubbleTimer);
      if (agent.fadeTimer) view.clearTimeout(agent.fadeTimer);
      agent.bubbleTimer = view.setTimeout(() => agent.bubble.classList.add("fading"), MESSAGE_TTL_MS - 350);
      agent.fadeTimer = view.setTimeout(() => { agent.bubble.textContent = ""; }, MESSAGE_TTL_MS);
      place(agent, true);
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
        point: a.point,
        label: a.label.textContent,
        message: a.bubble.textContent,
        classes: [...a.el.classList].filter((c) => c !== "agent"),
      }));
    }

    return { update, remove, destroy, snapshot };
  }

  global.M9RPresence = { createPresenceOverlay, ROOT_ID };
})(typeof window !== "undefined" ? window : globalThis);
