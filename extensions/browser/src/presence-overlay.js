(function (global) {
  "use strict";

  const ROOT_ID = "m9r-presence-root";
  const EDGE = 10;
  const MESSAGE_TTL_MS = 4000;
  const FRAME_AUTH_TIMEOUT_MS = 1000;
  const IDLE_AFTER_MS = 4000;
  // Without a roster from the broker there is no "session ended" signal; an agent silent this long is taken as gone.
  const ORPHAN_AFTER_MS = 90000;
  // With a roster, an agent missing from it leaves once it has also been quiet for a moment.
  const MISSING_AFTER_MS = 20000;
  const HIDDEN_SESSIONS_KEY = "m9rHiddenMessageSessions";
  const POSITION_KEYS = { pill: "m9rPillPos", composer: "m9rComposerPos" };
  // Where the thread pill sits on its track around the window, as a fraction of the track's length (independent of window size).
  const DOCK_KEY = "m9rDockU";
  const MOTION_KEY = "m9rMotion";
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
    .focus{position:absolute;left:0;top:0;box-sizing:border-box;border:2px solid color-mix(in srgb,var(--c) 88%,white);border-radius:7px;pointer-events:none;opacity:0;transition:opacity 180ms ease;box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 18%,transparent),0 0 22px color-mix(in srgb,var(--c) 30%,transparent)}
    .focus.on{opacity:1}
    .focus.claimed{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--c),0 0 18px var(--c)}
    .focus-tag{position:absolute;box-sizing:border-box;max-width:min(320px,calc(100vw - 16px));padding:4px 8px;border:1px solid color-mix(in srgb,var(--c) 88%,white);border-radius:6px;background:color-mix(in srgb,var(--c) 82%,#101216);color:#fff;font:700 11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none}
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
    @media (prefers-reduced-motion:reduce){:host([data-motion="system"]) :is(.agent.idle .arrow,.agent.idle .badge,.caret,.label .caret-mini){animation:none}:host([data-motion="system"]) .ripple{animation-duration:1ms}}
  `;

  // Minimum-jerk profile: how a hand actually moves (slow start, fast middle, slow settle), not a symmetric ease.
  const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  // Fitts-style duration: longer trips take longer, but not proportionally.
  // The cursor is a progress signal, not a second animation to wait through.
  const glideDuration = (dist) => Math.min(650, Math.max(120, 110 + 75 * Math.log2(1 + dist / 30)));
  const DWELL_MS = 60;
  const FOCUS_FADE_MS = 500;
  let lastGlideStartAt = 0;
  // Repeated, nearby, and background actions do not need another theatrical delay.
  const reactionDelay = (fromParked, fast) => {
    if (fast) return 0;
    const now = performance.now();
    const base = fromParked ? 80 + Math.random() * 100 : 20 + Math.random() * 50;
    const stagger = now - lastGlideStartAt < 300 ? 30 + Math.random() * 70 : 0;
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
    const previousInstance = view.__m9rPresenceOverlayInstance;
    if (previousInstance && typeof previousInstance.destroy === "function") {
      try { previousInstance.destroy(); } catch { /* a stale overlay must not block its replacement */ }
    }
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

    // Motion is M9R's own setting (m9rMotion): "full" (the default) keeps cursors, the dock and the pill moving even when the operating
    // system has animations turned off, because where an agent is and where the pill went is information, not decoration; "system"
    // follows the OS "reduce motion" flag, which then gets brief straight glides instead of the full hand-like motion.
    const osReduced = view.matchMedia ? view.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    let motionMode = "full";
    const reducedMotion = { get matches() { return motionMode === "system" && osReduced.matches; } };
    host.setAttribute("data-motion", motionMode);
    const agents = new Map();
    const hiddenSessions = new Set();
    let destroyed = false;
    const storage = global.chrome && global.chrome.storage && global.chrome.storage.local;
    let onMotionChange = null;
    let motionBridge = null;
    const setMotionMode = (value) => {
      motionMode = value === "system" ? "system" : "full";
      host.setAttribute("data-motion", motionMode);
    };
    if (storage) {
      storage.get(MOTION_KEY).then((stored) => setMotionMode(stored && stored[MOTION_KEY])).catch(() => {});
      if (global.chrome.storage.onChanged) {
        onMotionChange = (changes, area) => {
          if (!destroyed && area === "local" && changes[MOTION_KEY]) setMotionMode(changes[MOTION_KEY].newValue);
        };
        motionBridge = view.__m9rPresenceMotionBridge;
        if (!motionBridge) {
          motionBridge = { handler: onMotionChange };
          motionBridge.listener = (...args) => { if (motionBridge.handler) return motionBridge.handler(...args); };
          view.__m9rPresenceMotionBridge = motionBridge;
          try { global.chrome.storage.onChanged.addListener(motionBridge.listener); }
          catch (error) {
            if (view.__m9rPresenceMotionBridge === motionBridge) delete view.__m9rPresenceMotionBridge;
            throw error;
          }
        } else motionBridge.handler = onMotionChange;
      }
    }
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

    function elementRect(element) {
      if (!element || typeof element.getBoundingClientRect !== "function") return null;
      let rect;
      try { rect = element.getBoundingClientRect(); } catch { return null; }
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return null;
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    function highlightRect(agent, now) {
      const selected = elementRect(resolveTarget(agent));
      if (selected) return selected;
      if (agent.nativePoint && typeof doc.elementFromPoint === "function") {
        let hit = null;
        try { hit = doc.elementFromPoint(agent.nativePoint.x, agent.nativePoint.y); } catch { /* A page may reject hit-testing during navigation. */ }
        if (hit && typeof hit.closest === "function") {
          try { hit = hit.closest("button,a,input,textarea,select,[role='button'],[contenteditable='true']") || hit; } catch { /* Keep the exact hit target. */ }
        }
        const hitRect = elementRect(hit);
        if (hitRect) return hitRect;
      }
      const hint = agent.hintRect;
      if (hint && now - hint.at < 4000 && Number.isFinite(hint.x) && Number.isFinite(hint.y) && Number.isFinite(hint.width) && Number.isFinite(hint.height) && hint.width > 0 && hint.height > 0) {
        return { left: hint.x, top: hint.y, width: hint.width, height: hint.height };
      }
      return null;
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
      if (agent.nativePoint) return agent.nativePoint;
      const el = resolveTarget(agent);
      // When the page cannot resolve the selector (a control in a shadow root or a replaced node), the extension still measured
      // the element; travel to that spot so the cursor never stays put while the click happens somewhere else.
      if (!el && agent.hintRect && now - agent.hintRect.at < 4000) return { x: agent.hintRect.x + Math.min(agent.hintRect.width / 2, 40 + agent.hintRect.width / 4), y: agent.hintRect.y + agent.hintRect.height / 2 };
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
      let keepFrame = false;
      for (const agent of agents.values()) {
        if (agent.nativePointerLive) keepFrame = true;
        const dest = destination(agent, now);
        let x = dest.x;
        let y = dest.y;
        if (agent.glide) {
          keepFrame = true;
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
        const activeRect = highlightRect(agent, now);
        const showFocus = activeRect && (agent.targetActive || agent.nativePointerLive || agent.focusUntil > now || agent.claimedUntil > now);
        agent.focus.classList.toggle("on", !!showFocus);
        agent.focus.classList.toggle("claimed", agent.claimedUntil > now && !(agent.focusUntil > now));
        if (showFocus) {
          const r = activeRect;
          // Nested outlines make simultaneous agents legible on the same target; cursor coordinates remain untouched.
          const inset = 4 + agent.slot * 3;
          const tagHeight = 21;
          const tagStack = agent.slot * 20;
          const tagAbove = r.top >= inset + tagHeight + tagStack + 4;
          const tagMaxWidth = Math.min(320, Math.max(0, vw - 16));
          const tagLeft = Math.min(Math.max(r.left, 4), Math.max(4, vw - tagMaxWidth - 4));
          agent.focus.style.transform = `translate3d(${r.left - inset}px, ${r.top - inset}px, 0)`;
          agent.focus.style.width = `${r.width + inset * 2}px`;
          agent.focus.style.height = `${r.height + inset * 2}px`;
          agent.focusTag.style.left = `${tagLeft - r.left + inset}px`;
          agent.focusTag.style.top = tagAbove ? `${-tagHeight - 3 - tagStack}px` : `${r.height + inset + 3 + tagStack}px`;
        }
        const typing = agent.verb === "type" && agent.typingUntil > now && agent.caretAt;
        agent.caret.classList.toggle("on", !!typing);
        if (typing) {
          agent.caret.style.transform = `translate3d(${agent.caretAt.x}px, ${agent.caretAt.y}px, 0)`;
          agent.caret.style.height = `${agent.caretAt.h}px`;
        }
        if (agent.typingEl && agent.typingUntil > now) {
          keepFrame = true;
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
          if (!agent.completed) setLabel(agent, isWorking(agent) ? "Thinking" : "Waiting", false);
          const to = dockPoint(agent);
          const from = agent.point || to;
          agent.glide = { from: { ...from }, start: performance.now(), duration: glideDuration(Math.hypot(to.x - from.x, to.y - from.y)), side: Math.random() < 0.5 ? -1 : 1, waiters: [] };
          keepFrame = true;
        }
        const idle = !agent.glide && now - agent.lastSeen > IDLE_AFTER_MS && !(agent.typingUntil > now) && !isWorking(agent);
        agent.el.classList.toggle("idle", idle);
        agent.miniCaret.hidden = !typing;
        if (agent.nativePointerLive || agent.typingUntil > now || agent.focusUntil > now || agent.claimedUntil > now || now - agent.lastActionAt <= 3200) keepFrame = true;
      }
      if (keepFrame) loop = view.requestAnimationFrame(frameTick);
    }

    function isWorking(agent) {
      const state = roster && roster.get(agent.id);
      return state === "working" || state === "starting";
    }

    /** Resolves once the agent's cursor has landed (plus a short dwell), so the page action happens after the cursor is there. */
    function whenArrived(id, timeoutMs) {
      return new Promise((resolve) => {
        const agent = agents.get(String(id || "").slice(0, 64));
        const timeout = Math.min(1000, Math.max(100, Number(timeoutMs) || 1000));
        const timer = view.setTimeout(resolve, timeout);
        const done = () => { view.clearTimeout(timer); resolve(); };
        if (!agent || !agent.glide) { view.setTimeout(done, DWELL_MS); return; }
        (agent.glide.waiters || (agent.glide.waiters = [])).push(done);
      });
    }

    function nativePointer(agentId, x, y, active) {
      const agent = agents.get(String(agentId || "").slice(0, 64));
      if (!agent || !Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(false);
      agent.lastSeen = Date.now();
      agent.lastActionAt = agent.lastSeen;
      agent.docked = false;
      agent.el.classList.remove("parked");
      agent.glide = null;
      agent.pendingClick = false;
      agent.point = { x, y };
      if (active) {
        agent.nativePoint = { x, y };
        agent.nativePointerLive = true;
        agent.targetActive = true;
      } else {
        agent.nativePoint = null;
        agent.nativePointerLive = false;
        agent.targetActive = false;
        agent.focusUntil = Math.max(agent.focusUntil, Date.now() + FOCUS_FADE_MS);
        agent.selector = null;
        agent.targetEl = null;
        agent.hintRect = null;
      }
      kick();
      // Wait for the position update to cross a rendered frame. The trusted OS
      // input host uses this acknowledgment before pressing the mouse button.
      return new Promise((resolve) => {
        view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve(true)));
      });
    }

    function kick() {
      if (!destroyed && !loop && agents.size) loop = view.requestAnimationFrame(frameTick);
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

    // A slot exists so two agents' cursors don't render on top of each other (it offsets each one's fan/dock position).
    // It used to be set once, from "how many agents exist right now", at the moment an agent's cursor was first created,
    // and never touched again. That meant a slot number is really "however many agents happened to exist at that exact
    // instant" -- if an agent later leaves and a new one joins, the new one can easily land on a slot number an existing
    // agent already has, and their cursors sit in the literal same spot ("perfectly overlapped"). Slots are now assigned
    // fresh, in a stable order, from the live roster every time membership changes.
    function reslot() {
      let i = 0;
      for (const agent of agents.values()) {
        agent.slot = i;
        agent.el.style.setProperty("--slot", String(agent.slot));
        i += 1;
      }
      kick();
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
      const focusTag = doc.createElement("span");
      focusTag.className = "focus-tag";
      focusTag.textContent = name.textContent;
      focus.appendChild(focusTag);
      const caret = doc.createElement("div");
      caret.className = "caret";
      caret.style.setProperty("--c", spec.color);
      layer.append(focus, caret, el);
      // New agents come in from the bottom centre of the page, where the pill and message bar live.
      const spawn = { x: view.innerWidth / 2, y: view.innerHeight - 90 };
      const agent = {
        id, el, label, step, bubble, focus, focusTag, caret, miniCaret, color: spec.color, provider: spec.label, sessionId: "",
        selector: null, targetEl: null, rect: null, point: null, spawn, glide: null, verb: "", pendingClick: false,
        focusUntil: 0, claimedUntil: 0, targetActive: false, typingUntil: 0, typingEl: null, lastTyped: null, caretAt: null,
        lastSeen: Date.now(), lastMessage: "", bubbleTimer: 0, fadeTimer: 0, claimTimer: 0, leaveTimer: 0,
        lastTargetAt: 0, completed: false,
        slot: agents.size, docked: false, lastActionAt: Date.now(),
      };
      agents.set(id, agent);
      reslot();
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

      if (!isAgentMessage) {
        agent.completed = phase === "done";
        setLabel(agent, hideText ? "M9R message hidden" : step || message, agent.completed);
      }
      const selector = msg.target && typeof msg.target.selector === "string" ? msg.target.selector : null;
      const hint = msg.target && msg.target.rect && Number.isFinite(msg.target.rect.x) && Number.isFinite(msg.target.rect.y) ? msg.target.rect : null;
      const exactPoint = msg.target && msg.target.point && Number.isFinite(msg.target.point.x) && Number.isFinite(msg.target.point.y)
        ? { x: msg.target.point.x, y: msg.target.point.y }
        : null;
      const verb = verbOf(msg);

      if (phase === "start" && !isAgentMessage) {
        agent.nativePoint = exactPoint;
        agent.nativePointerLive = false;
        agent.hintRect = hint ? { x: hint.x, y: hint.y, width: Number(hint.width) || 0, height: Number(hint.height) || 0, at: now } : null;
        agent.targetActive = Boolean(selector || agent.hintRect || exactPoint);
        agent.focusUntil = 0;
        const changedTarget = selector !== agent.selector;
        const sameTargetRecently = Boolean(selector && !changedTarget && now - agent.lastTargetAt < 1500);
        agent.verb = verb;
        if (selector) {
          agent.selector = selector;
          agent.lastTargetAt = now;
          if (changedTarget) agent.targetEl = null;
          const el = resolveTarget(agent);
          if (verb === "read") { agent.focusUntil = now + 2400; if (!reducedMotion.matches) readSweep(agent); }
          if (verb === "type" && el) {
            agent.typingEl = el;
            agent.lastTyped = null;
            agent.typingUntil = now + 2600;
          }
        } else {
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
          const fast = Boolean(view.document && view.document.hidden) || sameTargetRecently || dist < 48;
          const wait = reactionDelay(!agent.point || agent.wasParked, fast);
          agent.wasParked = false;
          lastGlideStartAt = performance.now() + wait;
          agent.glide = fast
            ? null
            : { from: { ...from }, start: performance.now() + wait, duration: glideDuration(dist), side: Math.random() < 0.5 ? -1 : 1, waiters: [] };
          if (fast) {
            agent.point = { ...to };
            arrive(agent);
          }
        } else {
          // Reduced motion trims the decoration, not the movement: the cursor still travels to its target, so people can see where
          // the agent is. It goes briefly and in a straight line, with no bow, overshoot or reaction delay.
          const to = destination(agent, now);
          const dist = Math.hypot(to.x - from.x, to.y - from.y);
          agent.wasParked = false;
          agent.glide = { from: { ...from }, start: performance.now(), duration: Math.min(380, 180 + dist * 0.18), side: 1, simple: true, waiters: [] };
        }
      } else if (phase === "done") {
        const hadActiveTarget = agent.targetActive;
        agent.targetActive = false;
        if (hadActiveTarget) agent.focusUntil = now + FOCUS_FADE_MS;
        else if (agent.verb === "read") agent.focusUntil = Math.min(agent.focusUntil, now + FOCUS_FADE_MS);
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
      reslot();
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

    function resume() {
      if (destroyed || !host.isConnected) return;
      for (const state of [...frames.values()]) {
        if (state.trace) state.trace(`U${state.ready ? "R" : "N"}${state.port ? "P" : "N"}`);
        // Broker startup broadcasts owner-resume to every tab, including tabs that
        // were never stopped. Keep a live authenticated frame intact; assigning its
        // extension URL again first navigates through page-origin about:blank and
        // invalidates the port that is already carrying the shared UI.
        if (state.ready && state.port && state.box.isConnected && state.frame.isConnected) {
          layout(state);
          continue;
        }
        clearFrameAuthTimer(state);
        closeFramePort(state);
        state.ready = false;
        state.pending.clear();
        if (!state.box.isConnected || !state.frame.isConnected) {
          try { state.frame.removeEventListener("load", state.onLoad); } catch {}
          frames.delete(state.kind);
          try { state.box.remove(); } catch {}
          const replacement = mountFrame(state.kind, state.src, state.defaults);
          if (replacement) {
            replacement.size = state.size;
            replacement.pos = state.pos;
            replacement.shown = state.shown;
            replacement.u = state.u;
            layout(replacement);
          }
          continue;
        }
        layout(state);
        state.frame.src = state.src;
      }
    }

    function suspend() {
      if (destroyed) return;
      for (const state of frames.values()) {
        clearFrameAuthTimer(state);
        closeFramePort(state);
        state.ready = false;
        state.pending.clear();
        layout(state);
      }
    }

    const sweep = view.setInterval(() => {
      const now = Date.now();
      for (const agent of [...agents.values()]) {
        if (roster ? !roster.has(agent.id) && now - agent.lastSeen > MISSING_AFTER_MS : now - agent.lastSeen > ORPHAN_AFTER_MS) leave(agent.id);
      }
    }, 5000);

    // ---- Extension-owned frames (the thread pill and the message bar), mounted inside this closed shadow root. ----
    const frames = new Map();
    const extensionOrigin = (() => {
      if (!global.chrome?.runtime || typeof global.chrome.runtime.getURL !== "function") return "";
      try {
        const root = new URL(global.chrome.runtime.getURL(""));
        // URL.origin serializes custom schemes as "null" in some runtimes. Chrome's
        // postMessage origin is the concrete extension scheme and host.
        return root.protocol === "chrome-extension:" && root.host ? `${root.protocol}//${root.host}` : "";
      } catch { return ""; }
    })();

    function mountFrame(kind, src, defaults) {
      if (frames.has(kind) || !extensionOrigin) return null;
      const frameStageKey = `m9r${kind.charAt(0).toUpperCase()}${kind.slice(1)}Frame`;
      const setFrameStage = (stage) => {
        try { if (host.isConnected && host.dataset) host.dataset[frameStageKey] = stage; } catch {}
      };
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
      let nonce = "";
      try { nonce = new URL(src, doc.baseURI).searchParams.get("n") || ""; } catch {}
      const state = { kind, box, frame, src, nonce, port: null, size: { w: defaults.w, h: defaults.h }, pos: null, shown: true, defaults, ready: false, pending: new Map(), setFrameStage, loadCount: 0, authCount: 0, retryCount: 0 };
      const traceKey = `m9r${kind === "pill" ? "Pill" : "Composer"}Lifecycle`;
      const trace = (stage) => {
        if (!host.dataset) return;
        host.dataset[traceKey] = `${host.dataset[traceKey] || ""}${stage};`.slice(-96);
      };
      state.trace = trace;
      setFrameStage("mounted");
      // The thread pill rides the dock track when the dock module is loaded; otherwise it keeps its old free position.
      state.dock = kind === "pill" && !!global.M9RDock;
      frames.set(kind, state);
      // Only a fixed reason code reaches the host DOM. It lets the owner diagnose a
      // missing pill without exposing the frame nonce or extension URL to the page.
      if (host.dataset) host.dataset.m9rFrameHandshake = "awaiting";
      state.onLoad = () => {
        if (destroyed || frames.get(kind) !== state || !host.isConnected || !frame.isConnected) return;
        state.loadCount++;
        if (host.dataset) host.dataset[`m9r${kind === "pill" ? "Pill" : "Composer"}Loads`] = String(state.loadCount);
        // Fixed reason codes only: identify a page-origin about:blank load without
        // exposing frame URLs or the handshake nonce to the embedding site.
        if (host.dataset) host.dataset[`m9r${kind === "pill" ? "Pill" : "Composer"}Recipient`] = frame.contentDocument ? "page-origin" : "cross-origin";
        trace(`L${state.loadCount}${frame.contentDocument ? "P" : "X"}${state.ready ? "R" : "N"}`);
        // The extension document can authenticate itself before its load event fires.
        // In that ordering, tearing down the newly transferred port here races a valid
        // handshake and can leave the frame waiting on a retry against about:blank.
        // A ready cross-origin frame has already proven its current document with the
        // tab nonce, so keep its channel and let subsequent navigation events re-auth.
        if (state.ready && !frame.contentDocument) return;
        clearFrameAuthTimer(state);
        // An about:blank load may precede the extension document, and the frame may
        // announce itself before its load event. Every load invalidates the old port
        // and hides the frame; an origin-targeted hello asks the new document to prove
        // itself. A foreign document cannot receive it, so the retry timer restores
        // the known extension URL without ever displaying untrusted frame content.
        closeFramePort(state);
        state.ready = false;
        setFrameStage("authenticating");
        layout(state);
        scheduleFrameAuthRetry(state);
        // about:blank inherits the page's origin. Do not post a chrome-extension://
        // target to that WindowProxy; wait for the bounded trusted-URL retry instead.
        if (frame.contentDocument) return;
        try {
          frame.contentWindow.postMessage({ m9r: "host-hello", nonce: state.nonce }, extensionOrigin);
          if (host.dataset) host.dataset[`m9r${kind === "pill" ? "Pill" : "Composer"}Hello`] = "sent";
        } catch {
          if (host.dataset) host.dataset[`m9r${kind === "pill" ? "Pill" : "Composer"}Hello`] = "rejected";
        }
        postToFrame(state, { kind: "host", vw: view.innerWidth, vh: view.innerHeight });
        if (state.dock && state.notifiedEdge) postToFrame(state, { kind: "dock", edge: state.notifiedEdge });
      };
      frame.addEventListener("load", state.onLoad);
      frame.src = src;
      if (storage && state.dock) {
        storage.get(DOCK_KEY).then((stored) => {
          if (destroyed || frames.get(kind) !== state) return;
          const saved = stored && stored[DOCK_KEY];
          if (Number.isFinite(saved) && saved >= 0 && saved <= 1) state.u = saved;
          layout(state);
        }).catch(() => { if (!destroyed && frames.get(kind) === state) layout(state); });
      } else if (storage) {
        storage.get(POSITION_KEYS[kind]).then((stored) => {
          if (destroyed || frames.get(kind) !== state) return;
          const saved = stored && stored[POSITION_KEYS[kind]];
          if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.bottom)) state.pos = { left: saved.left, bottom: saved.bottom };
          layout(state);
        }).catch(() => { if (!destroyed && frames.get(kind) === state) layout(state); });
      } else layout(state);
      return state;
    }

    function closeFramePort(state) {
      if (!state.port) return;
      try { state.port.close(); } catch {}
      state.port = null;
    }

    function clearFrameAuthTimer(state) {
      if (!state.authTimer) return;
      try { view.clearTimeout(state.authTimer); } catch {}
      state.authTimer = 0;
    }

    function scheduleFrameAuthRetry(state) {
      clearFrameAuthTimer(state);
      state.authTimer = view.setTimeout(() => {
        state.authTimer = 0;
        if (destroyed || state.ready || !host.isConnected || !state.frame.isConnected || frames.get(state.kind) !== state) return;
        // A load event has no origin. Until the frame proves its extension origin with its nonce,
        // keep it hidden and retry the known extension URL rather than leaving an orphan page mounted.
        state.setFrameStage("retrying");
        state.retryCount++;
        if (host.dataset) host.dataset[`m9r${state.kind === "pill" ? "Pill" : "Composer"}Retries`] = String(state.retryCount);
        if (host.dataset) host.dataset[`m9r${state.kind === "pill" ? "Pill" : "Composer"}Recipient`] = state.frame.contentDocument ? "page-origin" : "cross-origin";
        if (host.dataset) {
          const key = `m9r${state.kind === "pill" ? "Pill" : "Composer"}Lifecycle`;
          host.dataset[key] = `${host.dataset[key] || ""}R${state.retryCount}${state.frame.contentDocument ? "P" : "X"};`.slice(-96);
        }
        closeFramePort(state);
        const retryUrl = new URL(state.src);
        retryUrl.searchParams.set("m9r_retry", String(state.retryCount));
        state.frame.src = retryUrl.href;
      }, FRAME_AUTH_TIMEOUT_MS);
    }

    function postToFrame(state, payload) {
      if (!host.isConnected || !state.frame.isConnected) return;
      // A newly mounted iframe starts as about:blank with the page's origin. A load event alone is
      // insufficient proof that the extension page is the recipient; wait for its own authenticated
      // message before posting anything to it.
      if (!state.ready || !state.port) { state.pending.set(payload.kind, payload); return; }
      try { state.port.postMessage({ m9r: "host", nonce: state.nonce, ...payload }); }
      catch {
        state.ready = false;
        state.setFrameStage("channel-error");
        try { state.port.close(); } catch {}
        state.port = null;
        state.pending.set(payload.kind, payload);
      }
    }

    // Chrome's per-site zoom scales every CSS pixel, the pill included, so the same pill looked bigger on a site zoomed to 125% and
    // smaller at 80%. The background reports the tab's zoom and the frames are scaled back by 1/zoom (layout sees screen-sized boxes).
    let zoomK = 1;
    function setZoom(zoom) {
      const next = Number.isFinite(zoom) && zoom > 0.2 && zoom < 6 ? Math.min(2.5, Math.max(0.4, 1 / zoom)) : 1;
      if (Math.abs(next - zoomK) < 0.001) return;
      zoomK = next;
      for (const state of frames.values()) { state.appliedBase = false; layout(state); }
    }

    function layout(state) {
      if (state.dock) return layoutDock(state);
      const vw = view.innerWidth;
      const vh = view.innerHeight;
      const w = Math.min(state.size.w * zoomK, vw - 8);
      const h = Math.min(state.size.h * zoomK, vh - 8);
      let left = state.pos ? state.pos.left : (vw - w) / 2;
      let bottom = state.pos ? state.pos.bottom : state.defaults.bottom;
      left = Math.min(Math.max(left, 4), Math.max(4, vw - w - 4));
      bottom = Math.min(Math.max(bottom, 4), Math.max(4, vh - h - 4));
      state.box.style.cssText = `left:${left}px;bottom:${bottom}px;width:${w / zoomK}px;height:${h / zoomK}px;transform:scale(${zoomK});transform-origin:0 100%`;
      state.box.classList.add("ready");
      state.box.classList.toggle("hidden", !state.shown || !state.ready);
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
      // The layer is fixed to the viewport WITHOUT its scrollbars, so that is the size the notch has to hug (innerWidth includes the scrollbar and tucked the notch under it).
      const vw = doc.documentElement.clientWidth || view.innerWidth;
      const vh = doc.documentElement.clientHeight || view.innerHeight;
      const path = D.pathFor(vw, vh, DOCK);
      state.path = path;
      // Until the owner moves it, the pill rests on the bottom edge, right of centre, clear of the message bar.
      if (!Number.isFinite(state.u)) state.u = D.project(path, vw > 900 ? vw - 260 : vw / 2, vh).t / path.length;
      const point = D.pointAt(path, state.u * path.length);
      const o = D.orientationAt(point.theta);
      const w = Math.min(state.size.w * zoomK, vw - 8);
      const h = Math.min(state.size.h * zoomK, vh - 8);
      // The bar sits at the frame's bottom (its top when docked along the top), so growth always opens away from the edge.
      // Along the top and bottom the frame is centred on the track point; on the sides it hugs the edge and slides up and down.
      const half = DOCK.thickness / 2 + DOCK.pad;
      // On the left and right edges the pill is a notch: its frame sits exactly on the screen edge and the frame has no padding there.
      let left = o.card === 1 ? vw - w : o.card === 3 ? 0 : point.x - w / 2;
      // Every edge is a notch: the frame sits exactly on the screen edge it is docked to.
      let top = o.card === 0 ? 0 : o.card === 2 ? vh - h : point.y + half - h;
      if (o.card !== 1 && o.card !== 3) left = clampN(left, 4, Math.max(4, vw - w - 4));
      // The message bar owns the bottom centre. A notch docked on the bottom edge steps to the side of it instead of sitting behind it.
      if (o.card === 2) {
        const barLeft = vw / 2 - 240, barRight = vw / 2 + 240;
        if (left < barRight + 10 && left + w > barLeft - 10) {
          const right = barRight + 10, leftSide = barLeft - 10 - w;
          left = leftSide < 4 || (right + w <= vw - 4 && Math.abs(right - left) <= Math.abs(leftSide - left)) ? Math.min(right, Math.max(4, vw - w - 4)) : leftSide;
        }
      }
      // On the left and right edges the tab stays exactly where it is and the panel grows around it; the frame only slides when the panel would not fit.
      if ((o.card === 1 || o.card === 3) && state.bar) {
        top = point.y - (state.bar.top + state.bar.h / 2) * zoomK;
        // Give the panel only the room that is left below the tab, so opening it never has to move the tab; it scrolls inside instead.
        const cap = Math.floor(vh - 4 - Math.max(4, top) - 28);
        const capped = cap >= 240 ? cap : 0;
        if (capped !== state.lastCap) { state.lastCap = capped; postToFrame(state, { kind: "panel-max", px: Math.floor(capped / zoomK) }); }
      }
      if (o.card !== 0 && o.card !== 2) top = clampN(top, 4, Math.max(4, vh - h - 4));
      if (o.edge !== state.notifiedEdge) {
        state.notifiedEdge = o.edge;
        postToFrame(state, { kind: "dock", edge: o.edge });
      }
      const sp = dockSprings(state);
      // The dock always moves on springs (they settle without overshoot): where the pill goes is information, not decoration.
      // Resizing a cross-process frame on every animation frame is what made opening the thread lag, so a change of size is
      // instant (the panel animates inside the frame) and only sliding along the edge is sprung.
      const resized = state.lastW !== w || state.lastH !== h;
      state.lastW = w; state.lastH = h;
      if (!state.springsReady || resized) {
        sp.l.jump(left); sp.t.jump(top); sp.r.jump(left + w); sp.b.jump(top + h);
        state.springsReady = true;
      } else {
        sp.l.setTarget(left); sp.t.setTarget(top); sp.r.setTarget(left + w); sp.b.setTarget(top + h);
      }
      state.box.classList.add("ready");
      state.box.classList.toggle("hidden", !state.shown || !state.ready);
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
      // The 40px floor is a real on-screen minimum, so it has to be scaled the same way everything else here is: without
      // this, at a high page zoom the un-scaled 40 CSS px this box gets clamped up to is then multiplied by the browser's
      // own zoom again on top, landing far bigger on screen than 40px (the notch clipped off the bottom of the viewport
      // at 2x zoom because of exactly this).
      const w = Math.max(40 * zoomK, sp.r.value - left);
      const h = Math.max(40 * zoomK, sp.b.value - top);
      const st = state.box.style;
      if (state.appliedW !== w || state.appliedH !== h || !state.appliedBase) {
        st.cssText = `left:0;top:0;bottom:auto;width:${w / zoomK}px;height:${h / zoomK}px;will-change:transform;transform-origin:0 0`;
        state.appliedW = w; state.appliedH = h; state.appliedBase = true;
      }
      st.transform = `translate3d(${left}px,${top}px,0) scale(${zoomK})`;
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
      if (!host.isConnected) return null;
      for (const state of frames.values()) {
        if (state.box.isConnected && state.frame.isConnected && state.frame.contentWindow === source) return state;
      }
      return null;
    }

    function onFrameMessage(event) {
      const data = event.data;
      if (!data || data.m9r !== "frame") return;
      if (!extensionOrigin || event.origin !== extensionOrigin) {
        if (host.dataset) host.dataset.m9rFrameHandshake = "origin-mismatch";
        return;
      }
      const state = frameFor(event.source);
      if (!state) {
        if (host.dataset) host.dataset.m9rFrameHandshake = "source-mismatch";
        return;
      }
      if (!state.nonce || data.nonce !== state.nonce) {
        if (host.dataset) host.dataset.m9rFrameHandshake = "nonce-mismatch";
        return;
      }
      if (!state.ready) {
        if (typeof global.MessageChannel !== "function") return;
        const channel = new global.MessageChannel();
        state.port = channel.port1;
        try {
          state.frame.contentWindow.postMessage({ m9r: "host-port", nonce: state.nonce }, extensionOrigin, [channel.port2]);
        } catch {
          try { channel.port1.close(); } catch {}
          try { channel.port2.close(); } catch {}
          state.port = null;
          return;
        }
        state.ready = true;
        state.setFrameStage("ready");
        state.authCount++;
        if (host.dataset) host.dataset[`m9r${state.kind === "pill" ? "Pill" : "Composer"}Auths`] = String(state.authCount);
        if (host.dataset) host.dataset[`m9r${state.kind === "pill" ? "Pill" : "Composer"}Lifecycle`] = `${host.dataset[`m9r${state.kind === "pill" ? "Pill" : "Composer"}Lifecycle`] || ""}A${state.authCount}${state.frame.contentDocument ? "P" : "X"};`.slice(-96);
        if (host.dataset) host.dataset.m9rFrameHandshake = "ready";
        clearFrameAuthTimer(state);
        layout(state);
        const pending = [...state.pending.values()];
        state.pending.clear();
        for (const payload of pending) postToFrame(state, payload);
      }
      if (data.kind === "size" && Number.isFinite(data.w) && Number.isFinite(data.h)) {
        const before = state.shownAt;
        const grew = before && data.h !== state.size.h;
        state.size = { w: Math.max(40, Math.min(data.w, 900)), h: Math.max(40, Math.min(data.h, 2000)) };
        if (Number.isFinite(data.barTop) && Number.isFinite(data.barH)) state.bar = { top: data.barTop, h: data.barH };
        // Growing keeps the bottom edge where it is (the pill opens upward); if it would run off the top, it slides down.
        if (grew && state.pos) state.pos = { left: state.pos.left, bottom: state.pos.bottom };
        layout(state);
      } else if (data.kind === "drag" && state.dock && state.path && Number.isFinite(data.cx) && Number.isFinite(data.cy)) {
        // The pointer, in window coordinates: where the frame is drawn right now plus where the pointer is inside it.
        const at = state.cur || { left: 0, top: 0 };
        const hit = global.M9RDock.project(state.path, at.left + data.cx * zoomK, at.top + data.cy * zoomK);
        state.u = hit.t / state.path.length;
        layoutDock(state);
      } else if (data.kind === "drag" && Number.isFinite(data.dx) && Number.isFinite(data.dy)) {
        const at = state.shownAt || { left: 0, bottom: 0 };
        state.pos = { left: at.left + data.dx * zoomK, bottom: at.bottom - data.dy * zoomK };
        layout(state);
      } else if (data.kind === "drag-end" && state.dock) {
        if (storage && Number.isFinite(state.u)) void storage.set({ [DOCK_KEY]: state.u }).catch(() => {});
      } else if (data.kind === "drag-end") {
        if (storage && state.shownAt) void storage.set({ [POSITION_KEYS[state.kind]]: { left: state.shownAt.left, bottom: state.shownAt.bottom } }).catch(() => {});
      } else if (data.kind === "hotkey") {
        if (options && typeof options.onHotkey === "function" && (data.key === "m" || data.key === "n")) options.onHotkey(data.key, data.down === true);
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
      kick();
    }

    function onScroll() { kick(); }

    view.addEventListener("message", onFrameMessage);
    view.addEventListener("resize", onResize, { passive: true });
    view.addEventListener("scroll", onScroll, true);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      const attempt = (cleanup) => { try { cleanup(); } catch { /* one invalidated extension API must not strand the rest */ } };
      attempt(() => view.clearInterval(sweep));
      if (onMotionChange) {
        if (motionBridge && motionBridge.handler === onMotionChange) motionBridge.handler = null;
        try {
          global.chrome.storage.onChanged.removeListener(motionBridge.listener);
          if (view.__m9rPresenceMotionBridge === motionBridge) delete view.__m9rPresenceMotionBridge;
        } catch { /* Reuse one inert bridge if Chrome refuses removal during invalidation. */ }
        onMotionChange = null;
        motionBridge = null;
      }
      if (loop) attempt(() => view.cancelAnimationFrame(loop));
      if (dockLoop) attempt(() => view.cancelAnimationFrame(dockLoop));
      for (const id of [...agents.keys()]) attempt(() => remove(id));
      attempt(() => view.removeEventListener("message", onFrameMessage));
      attempt(() => view.removeEventListener("resize", onResize));
      attempt(() => view.removeEventListener("scroll", onScroll, true));
      for (const state of frames.values()) {
        clearFrameAuthTimer(state);
        attempt(() => state.frame.removeEventListener("load", state.onLoad));
        attempt(() => closeFramePort(state));
        state.pending.clear();
      }
      frames.clear();
      attempt(() => host.remove());
      if (view.__m9rPresenceOverlayInstance === api) delete view.__m9rPresenceOverlayInstance;
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

    function isDoneVisible(agentId, sessionId) {
      const agent = agents.get(String(agentId || "").slice(0, 64));
      return Boolean(
        !destroyed && host.isConnected && agent?.el.isConnected &&
        typeof sessionId === "string" && sessionId.length > 0 && agent.sessionId === sessionId &&
        agent.completed && agent.step.textContent === "Done" && agent.label.classList.contains("done")
      );
    }

    const api = {
      update, remove, leave, stop, resume, destroy, snapshot, isDoneVisible, syncAgents, nativePointer,
      mountFrame, showComposer, toggleComposer, togglePill, talk, whenArrived, setZoom, suspend,
    };
    view.__m9rPresenceOverlayInstance = api;
    return api;
  }

  global.M9RPresence = { createPresenceOverlay, ROOT_ID };
})(typeof window !== "undefined" ? window : globalThis);
