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
    updateRoute();
  }

  // ---- Who the message is for ----
  const route = $("route");
  let lastRecipients = [];
  const nameOf = (h) => (HANDLES.find((x) => x.handle === h) || { name: h }).name;
  const labelFor = (handles) => (handles.includes("all") ? "everyone" : handles.map(nameOf).join(", "));

  /** Typed @ mentions and chips are explicit; otherwise an agent's name at the start of a sentence counts ("Claude do X"). */
  function recipientsOf(text) {
    const chips = mentionsOf();
    if (chips.length) return { handles: chips.includes("all") ? ["all"] : [...new Set(chips)], source: "named" };
    const typed = [...text.matchAll(/(?:^|\s)@([\w-]+)/g)].map((m) => m[1].toLowerCase());
    if (typed.length) return { handles: typed.includes("all") ? ["all"] : [...new Set(typed)], source: "named" };
    const M = window.M9RMentions;
    if (!M) return { handles: lastRecipients, source: lastRecipients.length ? "sticky" : "none", check: false };
    const r = M.resolveRecipients(text, lastRecipients);
    return { handles: r.handles, source: r.source, check: r.confidence === "medium" || M.needsJudgment(text) };
  }

  function updateRoute() {
    const text = serialize().trim();
    if (!text || listening) { route.hidden = true; return; }
    const r = recipientsOf(text);
    route.classList.remove("warn");
    if (!r.handles.length) {
      route.textContent = "Who is this for? Start with a name, like Claude";
      route.classList.add("warn");
    } else if (r.source === "sticky") route.textContent = `Carries on with ${labelFor(r.handles)}`;
    else route.textContent = `To ${labelFor(r.handles)}${r.check ? " (check)" : ""}`;
    route.hidden = false;
  }

  /** Turns a name typed at the start of a sentence into the @mention the broker routes on: "Claude do X" becomes "@claude do X". */
  function withAddress(text, chips) {
    if (chips.length || /(?:^|\s)@[\w-]+/.test(text) || !window.M9RMentions) return { text, handles: chips };
    const found = window.M9RMentions.detect(text);
    if (!found.mentions.length && !found.everyone) return { text, handles: [] };
    let out = text;
    for (const m of [...found.mentions].sort((a, b) => b.start - a.start)) out = `${out.slice(0, m.start)}@${m.handle}${out.slice(m.end)}`;
    if (found.everyone) out = `@all ${out}`;
    return { text: out, handles: found.everyone ? ["all"] : found.mentions.map((m) => m.handle) };
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
    const typed = serialize().replace(/ /g, " ").trim();
    if (!typed) return;
    const address = withAddress(typed, mentionsOf());
    const text = address.text;
    const mentions = address.handles;
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
    if (mentions.length) lastRecipients = mentions.includes("all") ? ["all"] : [...new Set(mentions)];
    const names = mentions.includes("all")
      ? ["all your agents"]
      : [...new Set(mentions)].map(nameOf);
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

  // ---- Talk instead of type: hold Alt+M (a tap just opens the bar). Speech comes back as text in the box, never sent on its own. ----
  let listening = false;
  let recognizer = null;
  let heard = "";
  let talkCap = 0;

  function setLive(text) {
    status.textContent = text;
    status.classList.remove("bad");
    status.classList.add("live");
    status.hidden = false;
    input.style.visibility = "hidden";
    clearTimeout(statusTimer);
  }

  function clearLive() {
    status.hidden = true;
    status.classList.remove("live");
    input.style.visibility = "";
  }

  const SPEECH_ERRORS = {
    "not-allowed": "Allow the microphone for M9R, then hold Alt+M again",
    "service-not-allowed": "Allow the microphone for M9R, then hold Alt+M again",
    "audio-capture": "No microphone found",
    "network": "Speech needs an internet connection",
    "no-speech": "Didn't catch anything",
  };

  function talkStart() {
    if (listening) return;
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) { showStatus("Speech isn't available in this browser", true); return; }
    if (small) setSmall(false);
    heard = "";
    stopping = false;
    recognizer = new Speech();
    recognizer.lang = navigator.language || "en-US";
    recognizer.interimResults = true;
    recognizer.continuous = true;
    recognizer.maxAlternatives = 1;
    recognizer.onresult = (event) => {
      let interim = "";
      let done = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const piece = event.results[i][0] && event.results[i][0].transcript ? event.results[i][0].transcript : "";
        if (event.results[i].isFinal) done += piece; else interim += piece;
      }
      heard = done;
      setLive(`${done}${interim}`.trim() || "Listening…");
    };
    recognizer.onerror = (event) => {
      const message = SPEECH_ERRORS[event.error] || `Speech stopped: ${event.error}`;
      listening = false;
      bar.classList.remove("listening");
      clearLive();
      showStatus(message, event.error !== "no-speech");
    };
    recognizer.onend = () => {
      const wasListening = listening;
      listening = false;
      stopping = false;
      clearTimeout(talkCap);
      bar.classList.remove("listening");
      recognizer = null;
      if (!status.classList.contains("bad")) clearLive();
      const words = heard.trim();
      heard = "";
      if (wasListening && words) {
        // A text node, not execCommand: execCommand does nothing when the frame does not yet have system focus.
        const before = serialize();
        input.appendChild(document.createTextNode(`${before && !/\s$/.test(before) ? " " : ""}${words}`));
        focusInput();
      }
      syncSend();
    };
    listening = true;
    // If the key-up is ever missed (the window lost focus mid-press), speech still ends on its own.
    clearTimeout(talkCap);
    talkCap = setTimeout(talkStop, 45000);
    bar.classList.add("listening");
    route.hidden = true;
    setLive("Listening…");
    try { recognizer.start(); } catch { listening = false; bar.classList.remove("listening"); clearLive(); }
  }

  let stopping = false;
  function talkStop() {
    // Both keys coming up each call this; the recognizer should only be told once.
    if (!recognizer || !listening || stopping) return;
    stopping = true;
    try { recognizer.stop(); } catch { /* already stopped */ }
  }

  // The same gesture works while the bar itself has focus (the page's copy of this handler covers the rest of the page).
  const HOLD_MS = 280;
  let holdTimer = 0;
  let pressed = false;
  let held = false;
  const isTalkKey = (ev) => ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === "KeyM";
  window.addEventListener("keydown", (ev) => {
    if (!isTalkKey(ev) || ev.repeat || pressed) return;
    pressed = true;
    holdTimer = setTimeout(() => { held = true; F.toParent({ kind: "focus-composer" }); talkStart(); }, HOLD_MS);
  }, true);
  const releaseTalk = (ev) => {
    const isRelease = ev.code === "KeyM" || ev.key === "Alt";
    if (!isRelease) return;
    if (ev.type === "keyup" && (ev.key === "Alt" || (ev.code === "KeyM" && ev.altKey))) F.toParent({ kind: "talk-release" });
    // Talking was started by the page's copy of the gesture (focus then moved here), so the key comes up in this frame.
    if (!pressed) { if (listening) talkStop(); return; }
    pressed = false;
    clearTimeout(holdTimer);
    if (held) { held = false; talkStop(); }
  };
  window.addEventListener("keyup", releaseTalk, true);

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

  F.onHost((data) => {
    if (data.kind === "focus") { if (small) setSmall(false); else focusInput(); }
    else if (data.kind === "talk") { if (data.active) talkStart(); else talkStop(); }
  });
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
