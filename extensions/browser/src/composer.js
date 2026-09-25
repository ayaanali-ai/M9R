// The message bar: one line to message the owner's agents, with @ mentions shown as logo chips.
(function () {
  "use strict";
  const F = window.M9RFrame;
  const { el, chip, ringOf, displayName } = F;
  const $ = (id) => document.getElementById(id);
  const wrap = $("wrap"), bar = $("bar"), lead = $("lead"), input = $("input"), send = $("send"), menu = $("menu"), status = $("status");

  const HANDLES = [
    { handle: "claude", name: "Claude", provider: "claude" },
    { handle: "codex", name: "Codex", provider: "codex" },
    { handle: "opencode", name: "OpenCode", provider: "opencode" },
  ];
  let state = { agents: [] };
  let connected = false;
  let small = false;
  let options = [];
  let active = 0;
  let statusTimer = 0;

  const running = () => state.agents.filter((a) => a.state !== "stopped" && a.state !== "failed");

  function report() {
    const r = wrap.getBoundingClientRect();
    F.toParent({ kind: "size", w: Math.ceil(r.width), h: Math.ceil(r.height) });
  }

  function drawLead() {
    const list = running();
    const top = list.find((a) => a.state === "blocked") || list.find((a) => a.state === "waiting") || list.find((a) => a.state === "working" || a.state === "starting") || list[0];
    lead.dataset.ring = top ? ringOf(top.state) : "off";
    lead.title = (list.length ? `${list.map((a) => displayName(a.id, a.provider)).join(", ")} running. ` : "") + (small ? "Show the message bar" : "Hide the message bar (Alt+Shift+M)");
    lead.replaceChildren(el("span", `m9r-logo${connected ? "" : " stale"}`));
  }

  /** The message as the broker should read it: mention chips become @handle, line breaks stay. */
  function serialize(node = input) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
      else if (child.dataset && child.dataset.handle) out += `@${child.dataset.handle}`;
      else if (child.nodeName === "BR") out += "\n";
      else if (child.nodeName === "DIV") out += `\n${serialize(child)}`;
      else out += child.textContent || "";
    }
    return out;
  }

  function mentionsOf() {
    return [...input.querySelectorAll(".mention")].map((m) => m.dataset.handle);
  }

  function syncSend() {
    const ready = serialize().trim().length > 0;
    send.disabled = !ready;
    send.classList.toggle("ready", ready);
  }

  function queryAtCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !input.contains(node)) return null;
    const before = node.textContent.slice(0, range.startOffset);
    const m = /(^|\s)@([\w-]{0,20})$/.exec(before);
    if (!m) return null;
    return { node, start: range.startOffset - m[2].length - 1, end: range.startOffset, query: m[2].toLowerCase() };
  }

  function drawMenu() {
    const q = queryAtCaret();
    if (!q) { closeMenu(); return; }
    const all = { handle: "all", name: "All agents", provider: "", hint: running().length ? running().map((a) => displayName(a.id, a.provider)).join(", ") : "everyone available" };
    options = [...HANDLES, all].filter((o) => o.handle.startsWith(q.query) || o.name.toLowerCase().startsWith(q.query));
    if (!options.length) { closeMenu(); return; }
    active = Math.min(active, options.length - 1);
    menu.replaceChildren(...options.map((o, i) => {
      const b = el("button", `opt${i === active ? " on" : ""}`);
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(i === active));
      const agent = state.agents.find((a) => a.id === o.handle);
      b.append(o.handle === "all" ? el("span", "all-mark", "@") : chip(o.provider, "chip", agent ? ringOf(agent.state) : undefined), el("span", undefined, o.name));
      b.append(el("span", "hint", o.hint || (agent ? agent.state : `@${o.handle}`)));
      b.addEventListener("mousedown", (ev) => { ev.preventDefault(); choose(i); });
      return b;
    }));
    menu.hidden = false;
    report();
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    options = [];
    active = 0;
    report();
  }

  function mentionNode(option) {
    const node = el("span", "mention");
    node.contentEditable = "false";
    node.dataset.handle = option.handle;
    node.append(el("span", `logo p-${option.provider || "agent"}`), el("span", undefined, option.handle === "all" ? "all" : option.name));
    return node;
  }

  function choose(index) {
    const option = options[index];
    const q = queryAtCaret();
    if (!option || !q) return closeMenu();
    const after = q.node.splitText(q.start);
    after.textContent = after.textContent.slice(q.end - q.start);
    const chipNode = mentionNode(option);
    const space = document.createTextNode(" ");
    q.node.parentNode.insertBefore(chipNode, after);
    q.node.parentNode.insertBefore(space, after);
    const range = document.createRange();
    range.setStart(space, 1);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    closeMenu();
    syncSend();
  }

  function showStatus(text, bad) {
    status.textContent = text;
    status.classList.toggle("bad", !!bad);
    status.hidden = false;
    input.style.visibility = "hidden";
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; input.style.visibility = ""; }, bad ? 3500 : 1800);
  }

  async function submit() {
    const text = serialize().replace(/ /g, " ").trim();
    if (!text) return;
    const mentions = mentionsOf();
    send.disabled = true;
    // The owner's own instruction is the moment to ask, once, for access to every site (a user gesture in this extension's
    // frame). After that agents open pages without asking; risky actions still wait for approval.
    try {
      const all = { origins: ["https://*/*", "http://*/*"] };
      const asked = (await chrome.storage.local.get("m9rAllSitesAsked")).m9rAllSitesAsked === true;
      if (!asked && !await chrome.permissions.contains(all)) {
        await chrome.storage.local.set({ m9rAllSitesAsked: true });
        await chrome.permissions.request(all);
      }
    } catch { /* if Chrome declines, agents fall back to asking per site */ }
    const reply = await F.command({ type: "ui-command", text });
    if (!reply.ok) {
      showStatus(`Not sent: ${reply.error}`, true);
      syncSend();
      return;
    }
    input.replaceChildren();
    const names = mentions.includes("all")
      ? ["all your agents"]
      : [...new Set(mentions)].map((h) => (HANDLES.find((x) => x.handle === h) || { name: h }).name);
    showStatus(names.length ? `Sent to ${names.join(", ")}` : "Sent to your agents");
    syncSend();
  }

  function setSmall(next) {
    small = next;
    document.body.classList.toggle("small", small);
    $("field").hidden = small;
    send.hidden = small;
    closeMenu();
    drawLead();
    report();
    if (!small) focusInput();
  }

  function focusInput() {
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  input.addEventListener("input", () => { syncSend(); drawMenu(); });
  input.addEventListener("keyup", (ev) => { if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") drawMenu(); });
  input.addEventListener("focus", () => bar.classList.add("focused"));
  input.addEventListener("blur", () => { bar.classList.remove("focused"); setTimeout(closeMenu, 100); });
  input.addEventListener("paste", (ev) => {
    ev.preventDefault();
    const text = (ev.clipboardData && ev.clipboardData.getData("text/plain")) || "";
    document.execCommand("insertText", false, text.slice(0, 4000));
  });
  input.addEventListener("keydown", (ev) => {
    if (!menu.hidden && options.length) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        active = (active + (ev.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
        drawMenu();
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); choose(active); return; }
      if (ev.key === "Escape") { ev.preventDefault(); closeMenu(); return; }
    }
    if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); document.execCommand("insertLineBreak"); return; }
    if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); void submit(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); input.blur(); }
  });
  send.addEventListener("click", () => void submit());
  $("field").addEventListener("click", () => { if (document.activeElement !== input) focusInput(); });

  const wasDrag = F.draggable(bar, (t) => t.closest && (t.closest(".field") || t.closest(".send")));
  lead.addEventListener("click", () => { if (!wasDrag()) setSmall(!small); });

  F.onHost((data) => { if (data.kind === "focus") { if (small) setSmall(false); else focusInput(); } });
  F.onState((store) => {
    connected = store.connected;
    if (store.state) state = store.state;
    drawLead();
    report();
  });
  new ResizeObserver(report).observe(wrap);
  drawLead();
  syncSend();
  report();
  F.start();
})();
