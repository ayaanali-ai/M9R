// The thread pill: collapsed, the agents with their state rings and a short line each; open, four views of the same
// ui-state (Chat, Activity, Approvals, Agents). Every string from the broker is placed with textContent.
(function () {
  "use strict";
  const F = window.M9RFrame;
  const { el, chip, ringOf, displayName, ago } = F;
  const $ = (id) => document.getElementById(id);
  const bar = $("bar"), agentsEl = $("agents"), badge = $("badge"), panel = $("panel"), tabsEl = $("tabs"), view = $("view"), foot = $("foot"), mark = $("mark"), wrap = $("wrap");

  // One thread carries everything that happens (messages, what agents do, approvals waiting for you); the other tab is who is here.
  const TABS = [["chat", "Chat"], ["agents", "Agents"]];
  const MAX_MARKS = 3;
  const memory = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  };

  let state = { agents: [], thread: [], approvals: [] };
  let connected = false;
  let open = memory.get("m9r.pill.open") === "1";
  let tab = TABS.some(([t]) => t === memory.get("m9r.pill.tab")) ? memory.get("m9r.pill.tab") : "chat";
  const seen = { chat: new Set() };
  const unread = { chat: false, agents: false };
  let primed = false;
  let pulseApprovals = false;
  const decided = new Map();
  let stopping = new Set();
  let lastBar = { top: 14, h: 44 };

  // The host tells the pill which window edge it is docked to, so the panel can open away from that edge.
  F.onHost((data) => {
    if (data && data.kind === "dock" && /^(top|right|bottom|left)$/.test(String(data.edge))) document.body.dataset.edge = data.edge;
    if (data && data.kind === "panel-max" && Number.isFinite(data.px)) {
      document.documentElement.style.setProperty("--panel-max", data.px > 0 ? `${data.px}px` : "none");
      requestAnimationFrame(() => { if (!panel.hidden) panel.style.maxHeight = `${panelHeight()}px`; report(); });
    }
  });

  const isOwner = (t) => /^(you|owner)$/i.test(t.agent) || /^(you|owner)$/i.test(t.provider);
  const chatItems = () => state.thread.filter((t) => t.kind === "say" || t.kind === "system");
  const running = () => state.agents.filter((a) => a.state !== "stopped" && a.state !== "failed");

  function trackUnread() {
    const items = [...state.thread, ...state.approvals];
    const fresh = items.filter((i) => !seen.chat.has(i.id));
    if (primed && fresh.length && !(open && tab === "chat")) unread.chat = true;
    if (primed && state.approvals.some((a) => !seen.chat.has(a.id))) pulseApprovals = true;
    for (const i of items) seen.chat.add(i.id);
    primed = true;
  }

  function drawBar() {
    mark.classList.toggle("stale", !connected);
    // A stopped agent keeps its tile (dimmed): a new message starts it again, so it must stay visible and addressable.
    const list = state.agents;
    const shown = list.slice(0, MAX_MARKS);
    const nodes = shown.map((a) => {
      const who = el("span", "who");
      if (a.state === "stopped" || a.state === "failed") who.style.opacity = "0.45";
      const dot = chip(a.provider || a.id, "dot", ringOf(a.state, a.doing));
      who.title = `${displayName(a.id, a.provider)}: ${a.state}${a.doing ? " · " + a.doing : ""}`;
      who.append(dot, el("span", "doing", a.doing || (a.state === "idle" ? "Idle" : a.state.charAt(0).toUpperCase() + a.state.slice(1))));
      return who;
    });
    if (list.length > shown.length) nodes.push(el("span", "more", `+${list.length - shown.length}`));
    const idleText = connected ? (list.length ? "No agents working" : "No agents set up") : "M9R is not running on this computer";
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
    const counts = { chat: state.approvals.filter((a) => !decided.has(a.id)).length, agents: running().length };
    tabsEl.replaceChildren(...TABS.map(([key, label]) => {
      const b = el("button", `tab${tab === key ? " on" : ""}`);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(tab === key));
      b.append(el("span", undefined, label));
      if (key === "chat" && counts.chat) {
        b.append(el("span", `count${pulseApprovals ? " pulse" : ""}`, String(counts.chat)));
      } else if (key === "agents" && counts.agents) {
        b.append(el("span", "n", String(counts.agents)));
      }
      if (unread[key] && tab !== key) b.append(el("span", "unread"));
      b.addEventListener("click", () => select(key));
      return b;
    }));
    const close = el("button", "close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.title = "Close";
    close.textContent = "×";
    close.addEventListener("click", () => toggle(false));
    tabsEl.append(close);
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

  // Runs of what one agent did on the web collapse into one line (the latest action, and how many came before it).
  function actionNodes(items) {
    const nodes = [];
    for (let k = 0; k < items.length;) {
      const first = items[k];
      if (first.kind === "block") {
        const row = el("div", "note-row blocked");
        row.append(chip(first.provider || first.agent, "chip"), el("span", "txt", `${displayName(first.agent, first.provider)} was stopped: ${first.text.replace(/^blocked:\s*/i, "")}`), el("time", "when", ago(first.at)));
        nodes.push(row); k += 1; continue;
      }
      let end = k;
      while (end + 1 < items.length && items[end + 1].kind === "do" && items[end + 1].agent === first.agent) end += 1;
      const last = items[end];
      const row = el("div", `note-row${last.ok === false ? " failed" : ""}`);
      const where = hostOf(last);
      row.append(chip(last.provider || last.agent, "chip"), el("span", "txt", `${displayName(last.agent, last.provider)} · ${last.text}${where ? " · " + where : ""}`));
      if (end > k) row.append(el("span", "more-n", `+${end - k}`));
      row.append(el("time", "when", ago(last.at)));
      nodes.push(row);
      k = end + 1;
    }
    return nodes;
  }

  function drawChat() {
    const nodes = [];
    const thread = [...state.thread].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (let k = 0; k < thread.length;) {
      const t = thread[k];
      if (t.kind === "say" || t.kind === "system") { nodes.push(msgNode(t)); k += 1; continue; }
      const run = [];
      while (k < thread.length && (thread[k].kind === "do" || thread[k].kind === "block")) { run.push(thread[k]); k += 1; }
      if (!run.length) k += 1;
      else nodes.push(...actionNodes(run));
    }
    for (const a of state.agents.filter((x) => x.state === "working" || x.state === "starting")) {
      const row = el("div", "typing");
      const dots = el("span", "dots3");
      dots.append(el("i"), el("i"), el("i"));
      row.append(chip(a.provider || a.id, "chip", "working"), el("span", undefined, `${displayName(a.id, a.provider)} is working`), dots);
      nodes.push(row);
    }
    // What needs the owner sits at the end of the thread, where the eye already is.
    for (const p of state.approvals) nodes.push(approvalCard(p));
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

  function approvalCard(p) {
    {
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
        approve.addEventListener("click", () => void decide("ui-approve"));
        deny.addEventListener("click", () => void decide("ui-deny"));
        actions.append(approve, deny);
        card.append(actions);
      }
      return card;
    }
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
      row.append(chip(a.provider || a.id, "chip", ringOf(a.state, a.doing)));
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
    const base = Math.max(260, Math.min(560, F.host.vh - 150));
    // On a side edge the host reports how much room is left below the tab; the panel never asks for more, so the tab does not move.
    const cap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--panel-max"));
    return Number.isFinite(cap) && cap > 0 ? Math.min(base, cap) : base;
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
      else drawAgents();
      if (stick && tab === "chat") view.scrollTop = view.scrollHeight;
      else if (scrollToEnd) view.scrollTop = 0;
    }
    pulseApprovals = false;
    report();
  }

  function report() {
    const r = wrap.getBoundingClientRect();
    const b = document.getElementById("bar").getBoundingClientRect();
    // While the panel is open the tab is hidden (the panel takes the edge), so keep reporting where the tab was: it is the anchor.
    if (b.height > 0) lastBar = { top: Math.round(b.top - r.top), h: Math.round(b.height) };
    F.toParent({ kind: "size", w: Math.ceil(r.width), h: Math.ceil(r.height), barTop: lastBar.top, barH: lastBar.h });
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
  setInterval(() => { if (open && tab === "chat") render(false); }, 15000);
  render(false);
  F.start();
})();
