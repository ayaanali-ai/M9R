(function (global) {
  "use strict";

  const ROOT_ID = "m9r-presence-root";
  const EDGE = 10;
  const MESSAGE_TTL_MS = 4000;
  const GLIDE_MS = 480;
  const IDLE_AFTER_MS = 4000;
  // Without a roster from the broker there is no "session ended" signal; an agent silent this long is taken as gone.
  const ORPHAN_AFTER_MS = 90000;
  // With a roster, an agent missing from it leaves once it has also been quiet for a moment.
  const MISSING_AFTER_MS = 20000;
  const HIDDEN_SESSIONS_KEY = "m9rHiddenMessageSessions";
  const POSITION_KEYS = { pill: "m9rPillPos", composer: "m9rComposerPos" };
  // Where the thread pill sits on its track around the window, as a fraction of the track's length (independent of window size).
  const DOCK_KEY = "m9rDockU";
  // The pill's bar is 44px tall inside a frame with 14px of padding; the track keeps the bar 16px off the window edge.
  const DOCK = { thickness: 44, pad: 14, gap: 16, radius: 72 };

  const ARROW =
    '<svg viewBox="0 0 16 16"><path d="M1 1l5 13 2.2-5.3L13.5 6.5z" fill="var(--c)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  const STYLE = `
    .layer{position:fixed;inset:0;pointer-events:none;font:500 11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif}
    .agent{position:absolute;left:0;top:0;will-change:transform;transition:opacity 260ms ease}
    .agent.idle .arrow,.agent.idle .badge{animation:breathe 2.6s ease-in-out infinite}
    .agent.idle .label{opacity:.82}
    .agent.parked{opacity:.72}
    .sweep{position:fixed;left:0;right:0;top:0;height:72px;pointer-events:none;background:linear-gradient(to bottom,transparent,color-mix(in srgb,var(--c) 20%,transparent),transparent);animation:sweep 1000ms ease-in-out forwards}
    @keyframes sweep{from{transform:translateY(-72px);opacity:0}15%{opacity:1}85%{opacity:1}to{transform:translateY(100vh);opacity:0}}
    .agent.leaving{opacity:0}
    .agent.pressed .arrow{transform:scale(.82);transition:transform 90ms ease-out}
    .agent.offscreen .badge{outline:2px dashed rgba(255,255,255,.75);outline-offset:2px}
    .agent.flip-x .badge{left:-37px}
    .agent.flip-x .label,.agent.flip-x .bubble{left:auto;right:42px}
    .agent.flip-y .badge{top:-37px}
    .agent.flip-y .label{top:-40px}
    .agent.flip-y .bubble{top:auto;bottom:44px}
    .arrow{position:absolute;left:0;top:0;width:16px;height:16px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));transform-origin:0 0;transition:transform 160ms ease-out}
    .badge{position:absolute;left:11px;top:11px;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#fff;background:var(--c);font:700 12px/1 system-ui,sans-serif;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.28)}
    .provider-logo{width:16px;height:16px;object-fit:contain;display:block;filter:brightness(0) invert(1)}.label .provider-logo{width:13px;height:13px}.provider-fallback{font:700 12px/1 system-ui,sans-serif}
    .label{position:absolute;left:42px;top:calc(16px + var(--slot,0) * 36px);white-space:normal;padding:6px 11px;border-radius:12px;background:rgba(16,18,22,.97);color:#ebe8e1;font:600 14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08);width:max-content;max-width:min(320px,70vw);overflow-wrap:break-word;word-break:normal;transition:opacity 300ms ease}
    .label:empty{display:none}
    .label .name{color:#fff;margin-right:6px}.label .step{font-weight:500;color:#e2dfd8}.label.done .step{color:#9296a0}
    .label .caret-mini{display:inline-block;width:2px;height:13px;margin-left:3px;vertical-align:-2px;background:var(--c);animation:blink 1s steps(1) infinite}
    .lock{position:absolute;right:-17px;top:-5px;display:none;padding:2px 4px;border:1px solid #fff;border-radius:4px;background:#a32222;color:#fff;font:700 8px/1 system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3)}
    .agent.claimed .lock{display:block}
    .bubble{position:absolute;left:42px;top:calc(52px + var(--slot,0) * 36px);width:max-content;max-width:min(320px,70vw);padding:8px 11px;font:500 14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;border:1px solid rgba(255,255,255,.14);border-radius:3px 10px 10px 10px;background:rgba(22,25,30,.96);color:#ebe8e1;box-shadow:0 2px 8px rgba(0,0,0,.32);opacity:1;transition:opacity 350ms ease;white-space:normal;overflow-wrap:break-word;word-break:normal}
    .bubble:empty{display:none}.bubble.fading{opacity:0}
    .focus{position:absolute;left:0;top:0;border-radius:7px;pointer-events:none;opacity:0;transition:opacity 260ms ease;box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 70%,transparent),0 0 0 6px color-mix(in srgb,var(--c) 18%,transparent),0 0 22px color-mix(in srgb,var(--c) 30%,transparent)}
    .focus.on{opacity:1}
    .focus.claimed{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--c),0 0 18px var(--c)}
    .ripple{position:absolute;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;border:3px solid var(--c);background:color-mix(in srgb,var(--c) 34%,transparent);animation:ripple 560ms cubic-bezier(.2,.7,.2,1) forwards;pointer-events:none}
    .caret{position:absolute;width:2px;margin-left:1px;border-radius:1px;background:var(--c);box-shadow:0 0 6px var(--c);animation:blink 1s steps(1) infinite;pointer-events:none;display:none}
    .caret.on{display:block}
    .frame-host{position:fixed;left:0;bottom:0;pointer-events:auto;display:none;border:0;margin:0;padding:0;background:transparent}
    .frame-host.ready{display:block}
    .frame-host.hidden{display:none}
    .frame-host iframe{display:block;border:0;margin:0;padding:0;background:transparent;color-scheme:dark;width:100%;height:100%}
    @keyframes breathe{0%,100%{opacity:1}50%{opacity:.55}}
    @keyframes blink{50%{opacity:0}}
    @keyframes ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1.25);opacity:0}}
    @media (prefers-reduced-motion:reduce){.agent.idle .arrow,.agent.idle .badge,.caret,.label .caret-mini{animation:none}.ripple{animation-duration:1ms}}
  `;

  // Minimum-jerk profile: how a hand actually moves (slow start, fast middle, slow settle), not a symmetric ease.
  const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  // Fitts-style duration: longer trips take longer, but not proportionally.
  const glideDuration = (dist) => Math.min(1200, Math.max(300, 260 + 140 * Math.log2(1 + dist / 30)));
  const DWELL_MS = 170;
  let lastGlideStartAt = 0;
  // People do not start moving the instant something happens, and two people rarely start in the same half second.
  const reactionDelay = (fromParked) => {
    const now = performance.now();
    const base = fromParked ? 260 + Math.random() * 300 : 60 + Math.random() * 140;
    const stagger = now - lastGlideStartAt < 700 ? 300 + Math.random() * 500 : 0;
    return base + stagger;
  };

  function verbOf(msg) {
    if (typeof msg.verb === "string") return msg.verb;
    const said = String(msg.action || msg.message || "").toLowerCase();
    if (/^(clicking|click)/.test(said)) return "click";
    if (/^(typing|type)/.test(said)) return "type";
    if (/^(reading|read)/.test(said)) return "read";
    if (/^(opening|open)/.test(said)) return "open";
    if (/^(scrolling|scroll)/.test(said)) return "scroll";
    return "";
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
    shadow.append(style, layer);
    doc.documentElement.appendChild(host);

    const reducedMotion = view.matchMedia ? view.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    const agents = new Map();
    const hiddenSessions = new Set();
    const storage = global.chrome && global.chrome.storage && global.chrome.storage.local;
    if (storage) {
      storage.get(HIDDEN_SESSIONS_KEY).then((stored) => {
        const saved = stored && stored[HIDDEN_SESSIONS_KEY];
        if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") hiddenSessions.add(id);
      }).catch(() => {});
    }
    let roster = null;
    let loop = 0;
    let measure = null;

    function providerSpec(provider) {
      return global.M9RPresenceLogic && global.M9RPresenceLogic.providerPresentation
        ? global.M9RPresenceLogic.providerPresentation(provider)
        : { label: String(provider || "Agent"), glyph: String(provider || "A").slice(0, 1).toUpperCase(), color: "#6b7280" };
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

    function resolveTarget(agent) {
      if (!agent.selector) return null;
      if (agent.targetEl && agent.targetEl.isConnected) return agent.targetEl;
      try { agent.targetEl = agent.selector.startsWith("@m9r-ref:") ? ((window.__m9rPageActionRefMap && window.__m9rPageActionRefMap.get(agent.selector.slice(9))) || null) : doc.querySelector(agent.selector); } catch { agent.targetEl = null; }
      return agent.targetEl;
    }

    /** Where the end of the text in a field is on screen, so the caret (and the cursor) can sit on it while typing. */
    function caretPoint(field, rect) {
      const cs = view.getComputedStyle(field);
      const padLeft = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
      const value = "value" in field ? String(field.value) : String(field.textContent || "");
      if (!measure) measure = doc.createElement("canvas").getContext("2d");
      let width = 0;
      if (measure) {
        measure.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
        const lastLine = value.split("\n").pop();
        width = measure.measureText(cs.textTransform === "uppercase" ? lastLine.toUpperCase() : lastLine).width;
      }
      const x = Math.min(rect.left + padLeft + width - (field.scrollLeft || 0), rect.right - parseFloat(cs.paddingRight) - 2);
      const lineHeight = Math.min(rect.height - 6, parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25 || 16);
      const isArea = field.tagName === "TEXTAREA" || field.isContentEditable;
      const lines = isArea ? value.split("\n").length : 1;
      const top = isArea ? Math.min(rect.top + parseFloat(cs.paddingTop) + (lines - 1) * lineHeight, rect.bottom - lineHeight - 4) : rect.top + (rect.height - lineHeight) / 2;
      return { x: Math.max(rect.left + padLeft, x), y: top, h: lineHeight };
    }

    // Where an agent parks while it is thinking or waiting: along the bottom-right edge, one spot per agent, so idle cursors
    // never pile up on the page or on each other.
    function dockPoint(agent) {
      return { x: view.innerWidth - 40 - agent.slot * 38, y: view.innerHeight - 46 };
    }

    function destination(agent, now) {
      if (agent.docked) return dockPoint(agent);
      const el = resolveTarget(agent);
      if (!el) return agent.point || agent.spawn;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return agent.point || agent.spawn;
      agent.rect = rect;
      if (agent.verb === "type" && agent.typingUntil > now) {
        const caret = caretPoint(el, rect);
        agent.caretAt = caret;
        return { x: caret.x + 3, y: caret.y + caret.h * 0.75 };
      }
      // Agents working on the same element are fanned out a little so their cursors and labels do not sit on top of each other.
      const fan = agents.size > 1 ? agent.slot * 14 : 0;
      return { x: rect.left + Math.min(rect.width / 2, 40 + rect.width / 4) + fan, y: rect.top + rect.height / 2 + fan * 0.6 };
    }

    function frameTick(now) {
      loop = 0;
      const vw = view.innerWidth;
      const vh = view.innerHeight;
      for (const agent of agents.values()) {
        const dest = destination(agent, now);
        let x = dest.x;
        let y = dest.y;
        if (agent.glide) {
          const g = agent.glide;
          const t = Math.max(0, Math.min(1, (performance.now() - g.start) / g.duration));
          const dx = dest.x - g.from.x;
          const dy = dest.y - g.from.y;
          if (g.simple) {
            // Reduced motion: a short straight glide that eases out, with no bow, wobble or overshoot.
            const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            x = g.from.x + dx * e;
            y = g.from.y + dy * e;
          } else {
            const k = minJerk(t);
            const dist = Math.hypot(dx, dy) || 1;
            // A quadratic curve bowed sideways (people never move in a ruler-straight line), plus a faint hand wobble that dies out on arrival.
            const nx = -dy / dist;
            const ny = dx / dist;
            const bow = Math.min(90, dist * 0.18) * g.side;
            const cx1 = g.from.x + dx / 2 + nx * bow;
            const cy1 = g.from.y + dy / 2 + ny * bow;
            const u = 1 - k;
            const wobble = Math.sin(k * Math.PI * 3) * 1.6 * (1 - k) * (dist > 40 ? 1 : 0);
            // On a long move the hand runs slightly past the target and comes back: an overshoot that is gone by arrival.
            const over = dist > 260 ? Math.min(14, dist * 0.03) : 0;
            const along = over * Math.pow(Math.sin(Math.PI * k), 2) * Math.min(1, Math.max(0, (k - 0.55) / 0.3));
            x = u * u * g.from.x + 2 * u * k * cx1 + k * k * dest.x + nx * wobble + (dx / dist) * along;
            y = u * u * g.from.y + 2 * u * k * cy1 + k * k * dest.y + ny * wobble + (dy / dist) * along;
          }
          if (t >= 1) {
            agent.glide = null;
            const waiting = g.waiters;
            arrive(agent);
            if (waiting && waiting.length) view.setTimeout(() => waiting.forEach((done) => done()), DWELL_MS);
          }
        }
        agent.point = { x, y };
        const cx = Math.min(Math.max(x, EDGE), vw - EDGE);
        const cy = Math.min(Math.max(y, EDGE), vh - EDGE);
        agent.el.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
        agent.el.classList.toggle("offscreen", cx !== x || cy !== y);
        agent.el.classList.toggle("flip-x", cx > vw - 300);
        agent.el.classList.toggle("flip-y", cy > vh - 110);
        const showFocus = agent.rect && (agent.focusUntil > now || agent.claimedUntil > now);
        agent.focus.classList.toggle("on", !!showFocus);
        agent.focus.classList.toggle("claimed", agent.claimedUntil > now && !(agent.focusUntil > now));
        if (showFocus) {
          const r = agent.rect;
          agent.focus.style.transform = `translate3d(${r.left - 4}px, ${r.top - 4}px, 0)`;
          agent.focus.style.width = `${r.width + 8}px`;
          agent.focus.style.height = `${r.height + 8}px`;
        }
        const typing = agent.verb === "type" && agent.typingUntil > now && agent.caretAt;
        agent.caret.classList.toggle("on", !!typing);
        if (typing) {
          agent.caret.style.transform = `translate3d(${agent.caretAt.x}px, ${agent.caretAt.y}px, 0)`;
          agent.caret.style.height = `${agent.caretAt.h}px`;
        }
        if (agent.typingEl && agent.typingUntil > now) {
          const value = "value" in agent.typingEl ? agent.typingEl.value : agent.typingEl.textContent;
          if (value !== agent.lastTyped) {
            agent.lastTyped = value;
            agent.typingUntil = Math.max(agent.typingUntil, now + 900);
          }
        }
        if (!agent.docked && !agent.glide && !(agent.typingUntil > now) && now - agent.lastActionAt > 3200 && !reducedMotion.matches) {
          agent.docked = true;
          agent.wasParked = true;
          agent.el.classList.add("parked");
          setLabel(agent, isWorking(agent) ? "Thinking" : "Waiting", false);
          const to = dockPoint(agent);
          const from = agent.point || to;
          agent.glide = { from: { ...from }, start: performance.now(), duration: glideDuration(Math.hypot(to.x - from.x, to.y - from.y)), side: Math.random() < 0.5 ? -1 : 1, waiters: [] };
        }
        const idle = !agent.glide && now - agent.lastSeen > IDLE_AFTER_MS && !(agent.typingUntil > now) && !isWorking(agent);
        agent.el.classList.toggle("idle", idle);
        agent.miniCaret.hidden = !typing;
      }
      if (agents.size) loop = view.requestAnimationFrame(frameTick);
    }

    function isWorking(agent) {
      const state = roster && roster.get(agent.id);
      return state === "working" || state === "starting";
    }

    /** Resolves once the agent's cursor has landed (plus a short dwell), so the page action happens after the cursor is there. */
    function whenArrived(id, timeoutMs) {
      return new Promise((resolve) => {
        const agent = agents.get(String(id || "").slice(0, 64));
        const timer = view.setTimeout(resolve, timeoutMs || 1800);
        const done = () => { view.clearTimeout(timer); resolve(); };
        if (!agent || !agent.glide) { view.setTimeout(done, DWELL_MS); return; }
        (agent.glide.waiters || (agent.glide.waiters = [])).push(done);
      });
    }

    function kick() {
      if (!loop && agents.size) loop = view.requestAnimationFrame(frameTick);
    }

    function arrive(agent) {
      if (agent.pendingClick) {
        agent.pendingClick = false;
        ripple(agent);
      }
    }

    // Reading looks like reading: a soft band sweeps down the page in the agent's colour.
    function readSweep(agent) {
      const band = doc.createElement("div");
      band.className = "sweep";
      band.style.setProperty("--c", agent.color);
      band.addEventListener("animationend", () => band.remove());
      layer.appendChild(band);
    }

    function ripple(agent) {
      const point = agent.point;
      if (!point) return;
      const ring = doc.createElement("div");
      ring.className = "ripple";
      ring.style.cssText = `left:${point.x}px;top:${point.y}px;--c:${agent.color}`;
      ring.addEventListener("animationend", () => ring.remove());
      view.setTimeout(() => ring.remove(), 1200);
      layer.appendChild(ring);
      agent.el.classList.add("pressed");
      view.setTimeout(() => agent.el.classList.remove("pressed"), 140);
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
      const name = doc.createElement("span");
      name.className = "name";
      const sameAsProvider = String(id).toLowerCase() === String(spec.label).toLowerCase();
      name.textContent = sameAsProvider ? spec.label : `${id} · ${spec.label}`;
      const step = doc.createElement("span");
      step.className = "step";
      const miniCaret = doc.createElement("span");
      miniCaret.className = "caret-mini";
      miniCaret.hidden = true;
      label.append(name, step, miniCaret);
      const bubble = doc.createElement("div");
      bubble.className = "bubble";
      el.append(svg, badge, label, bubble);
      const focus = doc.createElement("div");
      focus.className = "focus";
      focus.style.setProperty("--c", spec.color);
      const caret = doc.createElement("div");
      caret.className = "caret";
      caret.style.setProperty("--c", spec.color);
      layer.append(focus, caret, el);
      // New agents come in from the bottom centre of the page, where the pill and message bar live.
      const spawn = { x: view.innerWidth / 2, y: view.innerHeight - 90 };
      const agent = {
        id, el, label, step, bubble, focus, caret, miniCaret, color: spec.color, provider: spec.label, sessionId: "",
        selector: null, targetEl: null, rect: null, point: null, spawn, glide: null, verb: "", pendingClick: false,
        focusUntil: 0, claimedUntil: 0, typingUntil: 0, typingEl: null, lastTyped: null, caretAt: null,
        lastSeen: Date.now(), lastMessage: "", bubbleTimer: 0, fadeTimer: 0, claimTimer: 0, leaveTimer: 0,
        slot: agents.size, docked: false, lastActionAt: Date.now(),
      };
      el.style.setProperty("--slot", String(agent.slot));
      agents.set(id, agent);
      return agent;
    }

    function setLabel(agent, text, done) {
      agent.step.textContent = text;
      agent.label.classList.toggle("done", !!done);
    }

    function update(msg) {
      const id = String(msg.agent || "").slice(0, 64);
      if (!id) return;
      let agent = agents.get(id);
      if (agent && agent.leaveTimer) {
        view.clearTimeout(agent.leaveTimer);
        agent.leaveTimer = 0;
        agent.el.classList.remove("leaving");
      }
      if (!agent) agent = createAgent(id, msg.provider || id);
      const now = Date.now();
      agent.lastSeen = now;
      agent.sessionId = typeof msg.sessionId === "string" ? msg.sessionId : agent.sessionId;
      const summary = global.M9RPresenceLogic ? global.M9RPresenceLogic.formatPresenceMessage({ ...msg, agent: id }, now) : null;
      const message = summary?.message ?? (typeof msg.action === "string" ? msg.action.slice(0, 80) : "");
      const step = typeof msg.step === "string" && msg.step.trim() ? msg.step.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      const phase = msg.phase === "done" ? "done" : "start";
      const isAgentMessage = msg.messageKind === "agent_message";
      if (isAgentMessage) agent.lastMessage = message;
      const hideText = isAgentMessage && (msg.showMessageText === false || (agent.sessionId && hiddenSessions.has(agent.sessionId)));

      if (!isAgentMessage) setLabel(agent, hideText ? "M9R message hidden" : step || message, phase === "done");
      const selector = msg.target && typeof msg.target.selector === "string" ? msg.target.selector : null;
      const verb = verbOf(msg);

      if (phase === "start" && !isAgentMessage) {
        const changedTarget = selector !== agent.selector;
        agent.verb = verb;
        if (selector) {
          agent.selector = selector;
          if (changedTarget) agent.targetEl = null;
          const el = resolveTarget(agent);
          if (verb === "read") { agent.focusUntil = now + 2400; if (!reducedMotion.matches) readSweep(agent); }
          if (verb === "type" && el) {
            agent.typingEl = el;
            agent.lastTyped = null;
            agent.typingUntil = now + 2600;
          }
        } else if (verb === "open") {
          agent.selector = null;
          agent.targetEl = null;
        }
        agent.pendingClick = verb === "click";
        const from = agent.point || agent.spawn;
        agent.docked = false;
        agent.el.classList.remove("parked");
        agent.lastActionAt = now;
        if (!reducedMotion.matches) {
          const to = destination(agent, now);
          const dist = Math.hypot(to.x - from.x, to.y - from.y);
          const wait = reactionDelay(!agent.point || agent.wasParked);
          agent.wasParked = false;
          lastGlideStartAt = performance.now() + wait;
          agent.glide = { from: { ...from }, start: performance.now() + wait, duration: glideDuration(dist), side: Math.random() < 0.5 ? -1 : 1, waiters: [] };
        } else {
          // Reduced motion trims the decoration, not the movement: the cursor still travels to its target, so people can see where
          // the agent is. It goes briefly and in a straight line, with no bow, overshoot or reaction delay.
          const to = destination(agent, now);
          const dist = Math.hypot(to.x - from.x, to.y - from.y);
          agent.wasParked = false;
          agent.glide = { from: { ...from }, start: performance.now(), duration: Math.min(380, 180 + dist * 0.18), side: 1, simple: true, waiters: [] };
        }
      } else if (phase === "done") {
        if (agent.verb === "read") agent.focusUntil = Math.min(agent.focusUntil, now + 500);
        if (agent.verb === "type") agent.typingUntil = Math.min(agent.typingUntil, now + 300);
        if (verb === "click" && agent.pendingClick && !agent.glide) arrive(agent);
      }

      agent.el.classList.toggle("claimed", msg.claimed === true);
      if (agent.claimTimer) view.clearTimeout(agent.claimTimer);
      if (msg.claimed === true) {
        const claimMs = Math.min(Math.max(Number(msg.claimMs) || 8000, 500), 60000);
        agent.claimedUntil = now + claimMs;
        agent.claimTimer = view.setTimeout(() => agent.el.classList.remove("claimed"), claimMs);
      } else if (phase === "start") {
        agent.claimedUntil = 0;
      }

      if (isAgentMessage || msg.blocked === true) {
        agent.bubble.textContent = hideText ? "M9R message hidden" : summary?.bubbleMessage ?? message;
        agent.bubble.classList.remove("fading");
        if (agent.bubbleTimer) view.clearTimeout(agent.bubbleTimer);
        if (agent.fadeTimer) view.clearTimeout(agent.fadeTimer);
        agent.bubbleTimer = view.setTimeout(() => agent.bubble.classList.add("fading"), MESSAGE_TTL_MS - 350);
        agent.fadeTimer = view.setTimeout(() => { agent.bubble.textContent = ""; }, MESSAGE_TTL_MS);
      }
      kick();
    }

    /** Fade the cursor out and take it off the page. Used when the agent stops or its session ends. */
    function leave(id) {
      const agent = agents.get(id);
      if (!agent || agent.leaveTimer) return;
      agent.el.classList.add("leaving");
      agent.focus.classList.remove("on");
      agent.caret.classList.remove("on");
      agent.leaveTimer = view.setTimeout(() => remove(id), reducedMotion.matches ? 0 : 280);
    }

    function remove(id) {
      const agent = agents.get(id);
      if (!agent) return;
      agent.el.remove();
      agent.focus.remove();
      agent.caret.remove();
      for (const timer of [agent.bubbleTimer, agent.fadeTimer, agent.claimTimer, agent.leaveTimer]) if (timer) view.clearTimeout(timer);
      agents.delete(id);
    }

    /** The broker's roster: agents that stopped, failed or left the session take their cursor with them. */
    function syncAgents(list) {
      if (!Array.isArray(list)) return;
      roster = new Map(list.filter((a) => a && typeof a.id === "string").map((a) => [a.id, a.state]));
      const now = Date.now();
      for (const agent of [...agents.values()]) {
        const state = roster.get(agent.id);
        if (state === "stopped" || state === "failed") leave(agent.id);
        else if (state === undefined && now - agent.lastSeen > MISSING_AFTER_MS) leave(agent.id);
      }
      kick();
    }

    function stop() {
      for (const id of [...agents.keys()]) leave(id);
    }

    function resume() {}

    const sweep = view.setInterval(() => {
      const now = Date.now();
      for (const agent of [...agents.values()]) {
        if (roster ? !roster.has(agent.id) && now - agent.lastSeen > MISSING_AFTER_MS : now - agent.lastSeen > ORPHAN_AFTER_MS) leave(agent.id);
      }
    }, 5000);

    // ---- Extension-owned frames (the thread pill and the message bar), mounted inside this closed shadow root. ----
    const frames = new Map();
    const extensionOrigin = global.chrome && global.chrome.runtime && typeof global.chrome.runtime.getURL === "function"
      ? new URL(global.chrome.runtime.getURL("")).origin
      : "";

    function mountFrame(kind, src, defaults) {
      if (frames.has(kind) || !extensionOrigin) return null;
      const box = doc.createElement("div");
      box.className = "frame-host";
      const frame = doc.createElement("iframe");
      frame.setAttribute("title", kind === "pill" ? "M9R agents" : "M9R message bar");
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("scrolling", "no");
      // Lets the message bar use the microphone for push-to-talk. A site that forbids the microphone in its own Permissions-Policy still wins.
      frame.setAttribute("allow", "microphone");
      box.appendChild(frame);
      shadow.appendChild(box);
      const state = { kind, box, frame, src, size: { w: defaults.w, h: defaults.h }, pos: null, shown: true, loads: 0, defaults };
      // The thread pill rides the dock track when the dock module is loaded; otherwise it keeps its old free position.
      state.dock = kind === "pill" && !!global.M9RDock;
      frames.set(kind, state);
      frame.addEventListener("load", () => {
        state.loads += 1;
        // A page can navigate a child frame it can see through window.frames; if our frame is ever
        // navigated away from the pill, rebuild it rather than show whatever it was pointed at.
        if (state.loads > 1) {
          state.loads = 0;
          frame.src = src;
          return;
        }
        postToFrame(state, { kind: "host", vw: view.innerWidth, vh: view.innerHeight });
        if (state.dock && state.notifiedEdge) postToFrame(state, { kind: "dock", edge: state.notifiedEdge });
      });
      frame.src = src;
      if (storage && state.dock) {
        storage.get(DOCK_KEY).then((stored) => {
          const saved = stored && stored[DOCK_KEY];
          if (Number.isFinite(saved) && saved >= 0 && saved <= 1) state.u = saved;
          layout(state);
        }).catch(() => layout(state));
      } else if (storage) {
        storage.get(POSITION_KEYS[kind]).then((stored) => {
          const saved = stored && stored[POSITION_KEYS[kind]];
          if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.bottom)) state.pos = { left: saved.left, bottom: saved.bottom };
          layout(state);
        }).catch(() => layout(state));
      } else layout(state);
      return state;
    }

    function postToFrame(state, payload) {
      try { state.frame.contentWindow.postMessage({ m9r: "host", ...payload }, extensionOrigin); } catch {}
    }

    function layout(state) {
      if (state.dock) return layoutDock(state);
      const vw = view.innerWidth;
      const vh = view.innerHeight;
      const w = Math.min(state.size.w, vw - 8);
      const h = Math.min(state.size.h, vh - 8);
      let left = state.pos ? state.pos.left : (vw - w) / 2;
      let bottom = state.pos ? state.pos.bottom : state.defaults.bottom;
      left = Math.min(Math.max(left, 4), Math.max(4, vw - w - 4));
      bottom = Math.min(Math.max(bottom, 4), Math.max(4, vh - h - 4));
      state.box.style.cssText = `left:${left}px;bottom:${bottom}px;width:${w}px;height:${h}px`;
      state.box.classList.add("ready");
      state.box.classList.toggle("hidden", !state.shown);
      state.shownAt = { left, bottom, w, h };
    }

    // ---- Dock: the thread pill rides a rounded track just inside the window edge. A drag anywhere slides it along the
    // edges and around corners; every change of place or size is a spring, so nothing snaps. ----
    let dockLoop = 0;
    let dockLast = 0;
    const clampN = (value, low, high) => Math.min(Math.max(value, low), high);

    // The frame's four edges are the things that move, so switching from one window edge to another (or opening the panel)
    // glides continuously instead of jumping between placement rules.
    function dockSprings(state) {
      if (!state.springs) {
        const D = global.M9RDock;
        const make = () => D.createSpring({ ...D.SPRING_PRESETS.snap });
        state.springs = { l: make(), t: make(), r: make(), b: make() };
      }
      return state.springs;
    }

    function layoutDock(state) {
      const D = global.M9RDock;
      const vw = view.innerWidth;
      const vh = view.innerHeight;
      const path = D.pathFor(vw, vh, DOCK);
      state.path = path;
      // Until the owner moves it, the pill rests on the bottom edge, right of centre, clear of the message bar.
      if (!Number.isFinite(state.u)) state.u = D.project(path, vw > 900 ? vw - 260 : vw / 2, vh).t / path.length;
      const point = D.pointAt(path, state.u * path.length);
      const o = D.orientationAt(point.theta);
      const w = Math.min(state.size.w, vw - 8);
      const h = Math.min(state.size.h, vh - 8);
      // The bar sits at the frame's bottom (its top when docked along the top), so growth always opens away from the edge.
      // Along the top and bottom the frame is centred on the track point; on the sides it hugs the edge and slides up and down.
      const half = DOCK.thickness / 2 + DOCK.pad;
      let left = o.card === 1 ? vw - DOCK.gap + DOCK.pad - w : o.card === 3 ? DOCK.gap - DOCK.pad : point.x - w / 2;
      let top = o.card === 0 ? point.y - half : point.y + half - h;
      left = clampN(left, 4, Math.max(4, vw - w - 4));
      top = clampN(top, 4, Math.max(4, vh - h - 4));
      if (o.edge !== state.notifiedEdge) {
        state.notifiedEdge = o.edge;
        postToFrame(state, { kind: "dock", edge: o.edge });
      }
      const sp = dockSprings(state);
      // The dock always moves on springs (they settle without overshoot): where the pill goes is information, not decoration.
      if (!state.springsReady) {
        sp.l.jump(left); sp.t.jump(top); sp.r.jump(left + w); sp.b.jump(top + h);
        state.springsReady = true;
      } else {
        sp.l.setTarget(left); sp.t.setTarget(top); sp.r.setTarget(left + w); sp.b.setTarget(top + h);
      }
      state.box.classList.add("ready");
      state.box.classList.toggle("hidden", !state.shown);
      applyDock(state);
      if (!Object.values(sp).every((s) => s.settled()) && !dockLoop) {
        dockLast = 0;
        dockLoop = view.requestAnimationFrame(stepDock);
      }
    }

    function applyDock(state) {
      const sp = state.springs;
      const vh = view.innerHeight;
      const left = sp.l.value;
      const top = sp.t.value;
      const w = Math.max(40, sp.r.value - left);
      const h = Math.max(40, sp.b.value - top);
      state.box.style.cssText = `left:${left}px;top:${top}px;bottom:auto;width:${w}px;height:${h}px`;
      state.cur = { left, top, width: w, height: h };
      state.shownAt = { left, bottom: vh - top - h, w, h };
    }

    function stepDock(stamp) {
      dockLoop = 0;
      const dt = dockLast ? (stamp - dockLast) / 1000 : 1 / 60;
      dockLast = stamp;
      let live = false;
      for (const state of frames.values()) {
        if (!state.dock || !state.springs) continue;
        const list = Object.values(state.springs);
        for (const s of list) s.step(dt);
        applyDock(state);
        if (!list.every((s) => s.settled())) live = true;
      }
      if (live) dockLoop = view.requestAnimationFrame(stepDock);
      else dockLast = 0;
    }

    function frameFor(source) {
      for (const state of frames.values()) if (state.frame.contentWindow === source) return state;
      return null;
    }

    function onFrameMessage(event) {
      if (!extensionOrigin || event.origin !== extensionOrigin) return;
      const state = frameFor(event.source);
      const data = event.data;
      if (!state || !data || data.m9r !== "frame") return;
      if (data.kind === "size" && Number.isFinite(data.w) && Number.isFinite(data.h)) {
        const before = state.shownAt;
        const grew = before && data.h !== state.size.h;
        state.size = { w: Math.max(40, Math.min(data.w, 900)), h: Math.max(40, Math.min(data.h, 2000)) };
        // Growing keeps the bottom edge where it is (the pill opens upward); if it would run off the top, it slides down.
        if (grew && state.pos) state.pos = { left: state.pos.left, bottom: state.pos.bottom };
        layout(state);
      } else if (data.kind === "drag" && state.dock && state.path && Number.isFinite(data.cx) && Number.isFinite(data.cy)) {
        // The pointer, in window coordinates: where the frame is drawn right now plus where the pointer is inside it.
        const at = state.cur || { left: 0, top: 0 };
        const hit = global.M9RDock.project(state.path, at.left + data.cx, at.top + data.cy);
        state.u = hit.t / state.path.length;
        layoutDock(state);
      } else if (data.kind === "drag" && Number.isFinite(data.dx) && Number.isFinite(data.dy)) {
        const at = state.shownAt || { left: 0, bottom: 0 };
        state.pos = { left: at.left + data.dx, bottom: at.bottom - data.dy };
        layout(state);
      } else if (data.kind === "drag-end" && state.dock) {
        if (storage && Number.isFinite(state.u)) void storage.set({ [DOCK_KEY]: state.u }).catch(() => {});
      } else if (data.kind === "drag-end") {
        if (storage && state.shownAt) void storage.set({ [POSITION_KEYS[state.kind]]: { left: state.shownAt.left, bottom: state.shownAt.bottom } }).catch(() => {});
      } else if (data.kind === "talk-release") {
        if (options && typeof options.onTalkRelease === "function") options.onTalkRelease();
      } else if (data.kind === "focus-composer") {
        showComposer(true);
      } else if (data.kind === "reset-position") {
        state.pos = null;
        if (state.dock) state.u = NaN;
        if (storage) void storage.remove(state.dock ? DOCK_KEY : POSITION_KEYS[state.kind]).catch(() => {});
        layout(state);
      }
    }

    function showComposer(focus) {
      const state = frames.get("composer");
      if (!state) return;
      state.shown = true;
      layout(state);
      if (focus) {
        try { state.frame.focus(); } catch {}
        postToFrame(state, { kind: "focus" });
      }
    }

    function toggleComposer() {
      const state = frames.get("composer");
      if (!state) return;
      if (state.shown) {
        state.shown = false;
        layout(state);
        try { view.focus(); } catch {}
      } else showComposer(true);
    }

    /** Start or stop push-to-talk in the message bar; starting also brings the bar up, whatever state a tap left it in. */
    function talk(active) {
      const state = frames.get("composer");
      if (!state) return;
      if (active) { state.shown = true; layout(state); }
      postToFrame(state, { kind: "talk", active: !!active });
    }

    function togglePill() {
      const state = frames.get("pill");
      if (!state) return;
      state.shown = !state.shown;
      layout(state);
    }

    function onResize() {
      for (const state of frames.values()) {
        layout(state);
        postToFrame(state, { kind: "host", vw: view.innerWidth, vh: view.innerHeight });
      }
    }

    view.addEventListener("message", onFrameMessage);
    view.addEventListener("resize", onResize, { passive: true });

    function destroy() {
      view.clearInterval(sweep);
      if (loop) view.cancelAnimationFrame(loop);
      if (dockLoop) view.cancelAnimationFrame(dockLoop);
      for (const id of [...agents.keys()]) remove(id);
      view.removeEventListener("message", onFrameMessage);
      view.removeEventListener("resize", onResize);
      host.remove();
    }

    function snapshot() {
      return [...agents.values()].map((a) => ({
        id: a.id,
        provider: a.provider,
        sessionId: a.sessionId,
        point: a.point,
        label: a.step.textContent,
        message: a.bubble.textContent,
        classes: [...a.el.classList].filter((c) => c !== "agent"),
      }));
    }

    return {
      update, remove, leave, stop, resume, destroy, snapshot, syncAgents,
      mountFrame, showComposer, toggleComposer, togglePill, talk, whenArrived,
    };
  }

  global.M9RPresence = { createPresenceOverlay, ROOT_ID };
})(typeof window !== "undefined" ? window : globalThis);
