// The thread pill: collapsed, the agents with their state rings and a short line each; open, four views of the same
// ui-state (Chat, Activity, Approvals, Agents). Every string from the broker is placed with textContent.
(function () {
  "use strict";
  const F = window.M9RFrame;
  const { el, chip, ringOf, displayName, ago } = F;
  const $ = (id) => document.getElementById(id);
  const bar = $("bar"), agentsEl = $("agents"), badge = $("badge"), panel = $("panel"), tabsEl = $("tabs"), view = $("view"), foot = $("foot"), mark = $("mark"), wrap = $("wrap");

  const TABS = [["chat", "Chat"], ["activity", "Activity"], ["approvals", "Approvals"], ["agents", "Agents"]];
  const MAX_MARKS = 3;
  const memory = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  };

  let state = { agents: [], thread: [], approvals: [] };
  let connected = false;
  let open = memory.get("m9r.pill.open") === "1";
  let tab = TABS.some(([t]) => t === memory.get("m9r.pill.tab")) ? memory.get("m9r.pill.tab") : "chat";
  let activityFilter = "all";
  const seen = { chat: new Set(), activity: new Set(), approvals: new Set() };
  const unread = { chat: false, activity: false, approvals: false, agents: false };
  let primed = false;
  let pulseApprovals = false;
  const decided = new Map();
  let stopping = new Set();

  // The host tells the pill which window edge it is docked to, so the panel can open away from that edge.
  F.onHost((data) => {
    if (data && data.kind === "dock" && /^(top|right|bottom|left)$/.test(String(data.edge))) document.body.dataset.edge = data.edge;
  });

  const isOwner = (t) => /^(you|owner)$/i.test(t.agent) || /^(you|owner)$/i.test(t.provider);
  const chatItems = () => state.thread.filter((t) => t.kind === "say" || t.kind === "system");
  const activityItems = () => state.thread.filter((t) => t.kind === "do" || t.kind === "block");
  const running = () => state.agents.filter((a) => a.state !== "stopped" && a.state !== "failed");

  function trackUnread() {
    const groups = { chat: chatItems(), activity: activityItems(), approvals: state.approvals };
    for (const [key, items] of Object.entries(groups)) {
      const fresh = items.filter((i) => !seen[key].has(i.id));
      if (primed && fresh.length && !(open && tab === key)) unread[key] = true;
      if (key === "approvals" && primed && fresh.length) pulseApprovals = true;
      for (const i of items) seen[key].add(i.id);
    }
    primed = true;
  }

  function drawBar() {
    mark.classList.toggle("stale", !connected);
    const list = running();
    const shown = list.slice(0, MAX_MARKS);
    const nodes = shown.map((a) => {
      const who = el("span", "who");
      const dot = chip(a.provider || a.id, "dot", ringOf(a.state));
      who.title = `${displayName(a.id, a.provider)}: ${a.state}${a.doing ? " · " + a.doing : ""}`;
      who.append(dot, el("span", "doing", a.doing || (a.state === "idle" ? "Idle" : a.state.charAt(0).toUpperCase() + a.state.slice(1))));
      return who;
    });
    if (list.length > shown.length) nodes.push(el("span", "more", `+${list.length - shown.length}`));
    const idleText = connected ? "No agents working" : "M9R is not running on this computer";
    if (!nodes.length) nodes.push(el("span", "quiet", idleText));
    // The notch shows only tiles, so the empty state's words move into the tooltip.
    const barEl = document.getElementById("bar");
    if (barEl) barEl.title = nodes.length === 1 && nodes[0].className === "quiet" ? idleText : "";
    agentsEl.replaceChildren(...nodes);
    const pending = state.approvals.filter((a) => !decided.has(a.id)).length;
    badge.hidden = pending === 0;
    badge.textContent = String(pending);
    badge.title = pending ? `${pending} waiting for you` : "";
    if (pulseApprovals && pending) {
      badge.classList.remove("pulse");
      void badge.offsetWidth;
      badge.classList.add("pulse");
    }
  }

  function drawTabs() {
    const counts = { chat: 0, activity: activityItems().length, approvals: state.approvals.filter((a) => !decided.has(a.id)).length, agents: running().length };
    tabsEl.replaceChildren(...TABS.map(([key, label]) => {
      const b = el("button", `tab${tab === key ? " on" : ""}`);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(tab === key));
      b.append(el("span", undefined, label));
      if (key === "approvals" && counts.approvals) {
        const c = el("span", `count${pulseApprovals ? " pulse" : ""}`, String(counts.approvals));
        b.append(c);
      } else if (key === "agents" || key === "activity") {
        if (counts[key]) b.append(el("span", "n", String(counts[key])));
      }
      if (unread[key] && tab !== key) b.append(el("span", "unread"));
      b.addEventListener("click", () => select(key));
      return b;
    }));
  }

  function select(key) {
    tab = key;
    unread[key] = false;
    memory.set("m9r.pill.tab", key);
    render(true);
  }

  function nearBottom() {
    return view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  }

  function msgNode(t) {
    if (t.kind === "system") return el("div", "notice", t.text);
    if (isOwner(t)) {
      const row = el("div", "msg mine");
      const body = el("div", "body");
      body.append(el("div", "text", t.text));
      const to = t.to ? ` · to ${t.to.split(",").map((h) => displayName(h)).join(", ")}` : "";
      const meta = el("div", "meta", `${ago(t.at)}${to}`);
      body.append(meta);
      row.append(body);
      return row;
    }
    const row = el("div", "msg");
    const body = el("div", "body");
    const head = el("div", "head");
    head.append(el("span", "name", displayName(t.agent, t.provider)));
    if (t.to) head.append(el("span", "to", `to ${t.to.split(",").map((h) => displayName(h)).join(", ")}`));
    head.append(el("time", "when", ago(t.at)));
    body.append(head, el("div", "text", t.text));
    row.append(chip(t.provider || t.agent, "chip"), body);
    return row;
  }

  function drawChat() {
    const nodes = chatItems().map(msgNode);
    for (const a of state.agents.filter((x) => x.state === "working" || x.state === "starting")) {
      const row = el("div", "typing");
      const dots = el("span", "dots3");
      dots.append(el("i"), el("i"), el("i"));
      row.append(chip(a.provider || a.id, "chip", "working"), el("span", undefined, `${displayName(a.id, a.provider)} is working`), dots);
      nodes.push(row);
    }
    if (!nodes.length) nodes.push(el("div", "empty", "Nothing said yet. Message your agents from the bar below; type @ to pick one."));
    view.replaceChildren(...nodes);
    const f = el("div", "foot");
    const reply = el("button", "btn", "Reply");
    reply.type = "button";
    reply.addEventListener("click", () => F.toParent({ kind: "focus-composer" }));
    f.append(el("span", "hint", "Messages go to your agents on this computer."), reply);
    foot.replaceChildren(f);
  }

  function hostOf(t) {
    if (t.site) return t.site;
    if (t.url) { try { return new URL(t.url).host; } catch { return ""; } }
    return t.tab || "";
  }

  function drawActivity() {
    const items = activityItems();
    const blocked = items.filter((t) => t.kind === "block");
    const chips = el("div", "chips");
    for (const [key, label, n] of [["all", "All", items.length], ["blocked", "Blocked", blocked.length]]) {
      const b = el("button", `fchip${activityFilter === key ? " on" : ""}`, `${label} ${n}`);
      b.type = "button";
      b.addEventListener("click", () => { activityFilter = key; render(true); });
      chips.append(b);
    }
    const shown = activityFilter === "blocked" ? blocked : items;
    const latestStart = new Map();
    for (const t of items) if (t.kind === "do") latestStart.set(t.agent, t.id);
    const working = new Set(state.agents.filter((a) => a.state === "working" || a.state === "starting").map((a) => a.id));
    const nodes = shown.map((t) => {
      const row = el("div", `act${t.kind === "block" ? " blocked" : ""}`);
      const body = el("div", "body");
      const head = el("div", "head");
      head.append(el("span", "name", displayName(t.agent, t.provider)));
      let tag;
      if (t.kind === "block") tag = el("span", "tag blocked", "Blocked");
      else if (t.ok === false) tag = el("span", "tag failed", "Failed");
      else if (t.phase !== "done" && latestStart.get(t.agent) === t.id && working.has(t.agent)) tag = el("span", "tag now", "Doing now");
      else tag = el("span", "tag done", "Done");
      head.append(tag, el("time", "when", ago(t.at)));
      body.append(head, el("div", "text", t.text.replace(/^blocked:\s*/i, "")));
      const where = [t.target, hostOf(t)].filter(Boolean).join(" · ");
      if (where) body.append(el("div", "where", where));
      row.append(chip(t.provider || t.agent, "chip"), body);
      return row;
    });
    if (!nodes.length) nodes.push(el("div", "empty", activityFilter === "blocked" ? "Nothing is blocked." : "No agent has done anything on the web yet."));
    view.replaceChildren(chips, ...nodes);
    foot.replaceChildren();
  }

  function drawApprovals() {
    const nodes = state.approvals.map((p) => {
      const card = el("div", "card");
      const head = el("div", "head");
      head.append(chip(p.provider || p.agent, "chip", "waiting"), el("span", "name", `${displayName(p.agent, p.provider)} wants to go ahead`));
      card.append(head, el("div", "text", p.text));
      const where = [p.action, hostOf(p)].filter(Boolean).join(" · ");
      if (where) card.append(el("div", "where", where));
      const done = decided.get(p.id);
      if (done) card.append(el("div", `result${done.ok ? "" : " bad"}`, done.text));
      else {
        const actions = el("div", "actions");
        const approve = el("button", "btn primary", "Approve");
        const deny = el("button", "btn", "Deny");
        approve.type = deny.type = "button";
        const decide = async (kind) => {
          approve.disabled = deny.disabled = true;
          const reply = await F.command({ type: kind, id: p.id });
          decided.set(p.id, reply.ok ? { ok: true, text: kind === "ui-approve" ? "Approved." : "Denied." } : { ok: false, text: `Couldn't send that: ${reply.error}` });
          if (!reply.ok) setTimeout(() => { decided.delete(p.id); render(); }, 5000);
          render();
        };
        if (p.kind === "site") {
          approve.textContent = "Allow site";
          // The click itself must call chrome.permissions.request (a user gesture in this extension page).
          approve.addEventListener("click", async () => {
            approve.disabled = deny.disabled = true;
            let granted = false;
            try { granted = await chrome.permissions.request({ origins: [p.pattern] }); } catch {}
            try { await chrome.runtime.sendMessage({ type: "m9r-consent-result", origin: p.origin, granted }); } catch {}
            decided.set(p.id, { ok: granted, text: granted ? "Allowed. The agent continues." : "Chrome did not allow it." });
            render();
          });
          deny.addEventListener("click", async () => {
            approve.disabled = deny.disabled = true;
            try { await chrome.runtime.sendMessage({ type: "m9r-consent-result", origin: p.origin, granted: false }); } catch {}
            decided.set(p.id, { ok: true, text: "Denied. The agent is told no." });
            render();
          });
        } else {
          approve.addEventListener("click", () => void decide("ui-approve"));
          deny.addEventListener("click", () => void decide("ui-deny"));
        }
        actions.append(approve, deny);
        card.append(actions);
      }
      return card;
    });
    if (!nodes.length) nodes.push(el("div", "empty", "Nothing needs you."));
    view.replaceChildren(...nodes);
    foot.replaceChildren();
  }

  function drawAgents() {
    const top = el("div", "top");
    top.append(el("span", undefined, "Agents"));
    const all = el("button", "btn danger", "Stop all");
    all.type = "button";
    all.disabled = running().length === 0;
    all.addEventListener("click", async () => {
      all.disabled = true;
      const reply = await F.command({ type: "ui-stop-all" });
      if (!reply.ok) { all.textContent = "Couldn't stop"; setTimeout(() => render(), 2500); }
    });
    top.append(all);
    const nodes = state.agents.map((a) => {
      const row = el("div", "agent");
      row.append(chip(a.provider || a.id, "chip", ringOf(a.state)));
      const main = el("div", "main");
      const title = el("div", "title", displayName(a.id, a.provider));
      title.append(el("span", `state ${a.state}`, ` · ${a.state === "waiting" ? "waiting for you" : a.state}`));
      main.append(title);
      if (a.doing) main.append(el("div", "doing", a.doing));
      if (a.folder) main.append(el("div", "folder", a.folder));
      const stop = el("button", "btn", stopping.has(a.id) ? "Stopping…" : "Stop");
      stop.type = "button";
      stop.disabled = a.state === "stopped" || a.state === "failed" || stopping.has(a.id);
      stop.addEventListener("click", async () => {
        stopping.add(a.id);
        render();
        const reply = await F.command({ type: "ui-stop", agent: a.id });
        if (!reply.ok) { stopping.delete(a.id); render(); }
      });
      row.append(main, stop);
      return row;
    });
    if (!nodes.length) nodes.push(el("div", "empty", connected ? "No agents yet." : "M9R is not running on this computer."));
    view.replaceChildren(top, ...nodes);
    foot.replaceChildren();
  }

  function panelHeight() {
    return Math.max(260, Math.min(560, F.host.vh - 150));
  }

  function render(scrollToEnd) {
    document.body.classList.toggle("open", open);
    panel.hidden = !open;
    drawBar();
    if (open) {
      unread[tab] = false;
      const stick = scrollToEnd || nearBottom();
      panel.style.maxHeight = `${panelHeight()}px`;
      drawTabs();
      if (tab === "chat") drawChat();
      else if (tab === "activity") drawActivity();
      else if (tab === "approvals") drawApprovals();
      else drawAgents();
      if (stick && (tab === "chat" || tab === "activity")) view.scrollTop = view.scrollHeight;
      else if (scrollToEnd) view.scrollTop = 0;
    }
    pulseApprovals = false;
    report();
  }

  function report() {
    const r = wrap.getBoundingClientRect();
    F.toParent({ kind: "size", w: Math.ceil(r.width), h: Math.ceil(r.height) });
  }

  function toggle(next) {
    open = typeof next === "boolean" ? next : !open;
    memory.set("m9r.pill.open", open ? "1" : "0");
    render(true);
  }

  const wasDrag = F.draggable(bar, (t) => t.closest && t.closest("button:not(.chev)"));
  F.draggable(tabsEl);
  bar.addEventListener("click", () => { if (!wasDrag()) toggle(); });
  bar.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
  window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && open) toggle(false); });

  F.onState((store) => {
    connected = store.connected;
    if (store.state) {
      state = store.state;
      for (const id of [...decided.keys()]) if (!state.approvals.some((a) => a.id === id)) decided.delete(id);
      stopping = new Set([...stopping].filter((id) => state.agents.some((a) => a.id === id && a.state !== "stopped" && a.state !== "failed")));
      trackUnread();
    }
    render(false);
  });
  F.onHost((data) => { if (data.kind === "host") render(false); });
  new ResizeObserver(report).observe(wrap);
  setInterval(() => { if (open && (tab === "chat" || tab === "activity")) render(false); }, 15000);
  render(false);
  F.start();
})();
