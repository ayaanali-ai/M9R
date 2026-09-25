/* M9R sandbox: three scripted bots on one page, driven through the real presence overlay.
   No AI runs here. The bots only replay the shapes real agents produce (presence, claims, blocked, messages),
   and the owner controls (instruct, approve, stop) work on the scripted bots. */
(function () {
  "use strict";

  const AGENTS = {
    claude: { name: "Claude", provider: "claude", color: "#c96442", glyph: "C" },
    codex: { name: "Codex", provider: "codex", color: "#0f9d7a", glyph: "X" },
    opencode: { name: "OpenCode", provider: "opencode", color: "#6a5acd", glyph: "O" },
  };
  const KEYS = Object.keys(AGENTS);
  const $ = (id) => document.getElementById(id);
  const overlay = window.M9RPresence.createPresenceOverlay(document);

  let gen = 0;
  let counter = 0;
  let startedAt = Date.now();
  let pendingApproval = null;
  const state = {};

  class Cancelled extends Error {}
  const alive = (g) => { if (g !== gen) throw new Cancelled(); };
  const sleep = (ms, g) => new Promise((resolve, reject) => setTimeout(() => (g === gen ? resolve() : reject(new Cancelled())), ms));

  // ---- console rendering ----
  function stamp() {
    const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function feed(text, cls) {
    const box = $("feed");
    const row = document.createElement("div");
    const t = document.createElement("time");
    t.textContent = stamp();
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    row.append(t, span);
    box.prepend(row);
    while (box.children.length > 40) box.lastChild.remove();
  }
  function setState(key, status, doing) {
    state[key] = { status, doing };
    renderRoster();
  }
  function logo(a) {
    const img = document.createElement("img");
    img.className = "pi";
    img.alt = "";
    img.src = "/try/assets/providers/" + a.provider + ".svg";
    return img;
  }
  function renderRoster() {
    const roster = $("roster");
    roster.textContent = "";
    for (const key of KEYS) {
      const a = AGENTS[key];
      const s = state[key] || { status: "idle", doing: "" };
      const row = document.createElement("div");
      row.className = "row";
      const dot = document.createElement("i");
      dot.style.background = a.color;
      dot.appendChild(logo(a));
      const mid = document.createElement("div");
      mid.textContent = a.name;
      const doing = document.createElement("span");
      doing.className = "doing";
      doing.textContent = s.doing || " ";
      mid.appendChild(doing);
      const st = document.createElement("span");
      st.className = "st";
      st.textContent = s.status;
      row.append(dot, mid, st);
      roster.appendChild(row);
    }
    renderHere();
  }
  function renderHere() {
    const here = $("here");
    here.textContent = "";
    const label = document.createElement("span");
    label.textContent = "Here now:";
    here.appendChild(label);
    const who = $("tabwho");
    who.textContent = "";
    let live = 0;
    for (const key of KEYS) {
      const a = AGENTS[key];
      const s = state[key] || { status: "idle", doing: "" };
      if (s.status === "stopped") continue;
      live += 1;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.tabIndex = 0;
      const i = document.createElement("i");
      i.style.background = a.color;
      i.appendChild(logo(a));
      chip.append(i, document.createTextNode(a.name));
      const pop = document.createElement("span");
      pop.className = "pop";
      const b = document.createElement("b");
      b.textContent = a.name + " · " + a.provider;
      const line = document.createElement("span");
      line.textContent = s.doing || s.status;
      pop.append(b, line);
      chip.appendChild(pop);
      here.appendChild(chip);
      const tdot = document.createElement("i");
      tdot.style.background = a.color;
      who.appendChild(tdot);
    }
    const small = document.createElement("small");
    small.textContent = live + " agent" + (live === 1 ? "" : "s");
    who.appendChild(small);
  }

  // ---- presence (through the real overlay) ----
  function present(key, msg, opts) {
    const a = AGENTS[key];
    const o = opts || {};
    counter += 1;
    const target = o.selector ? document.querySelector(o.selector) : null;
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    overlay.update({
      id: key + ":" + counter,
      agent: a.name,
      provider: a.provider,
      action: msg,
      message: msg,
      target: o.selector ? { selector: o.selector } : undefined,
      claimed: o.claimed === true,
      blocked: o.blocked === true,
      claimMs: o.claimMs || 0,
    });
    setState(key, o.blocked ? "blocked" : "working", msg);
    feed(a.name + ": " + msg, o.blocked ? "warn" : undefined);
  }
  async function typeInto(el, text, g, delay) {
    el.value = "";
    for (const ch of text) {
      alive(g);
      el.value += ch;
      await sleep(delay || 45, g);
    }
  }
  function idle(key) { setState(key, "idle", ""); }

  // ---- the scripted story ----
  async function play(g) {
    try {
      $("send-order").disabled = true;
      present("claude", "reading pricing", { selector: "#pricing-table" });
      await sleep(1500, g);
      present("codex", "reading shipping", { selector: "#shipping-p" });
      await sleep(1300, g);
      present("opencode", "checking returns", { selector: "#returns-p" });
      await sleep(1500, g);
      present("claude", "to Codex: 12+ rate is $22 for totes", { selector: "#pricing-table" });
      await sleep(1700, g);
      present("codex", "to Claude: shipping is a flat $9", { selector: "#shipping-p" });
      await sleep(1700, g);
      present("opencode", "verified ✓ 12+ price matches returns page", { selector: "#returns-p" });
      feed("A finding was confirmed by a second agent before anyone used it.", "ok");
      await sleep(2000, g);

      // collision: two agents want the same field
      present("claude", "typing in Order number", { selector: "#order-number", claimed: true, claimMs: 4200 });
      const input = $("order-number");
      const typing = typeInto(input, "HG-1042", g, 90);
      await sleep(900, g);
      present("codex", "blocked: Claude has this field", { selector: "#order-number", blocked: true });
      feed("Codex was refused: Claude holds the field.", "warn");
      await typing;
      await sleep(1200, g);
      idle("claude");
      present("codex", "field is free, typing the note", { selector: "#order-note", claimed: true, claimMs: 3500 });
      await typeInto($("order-note"), "12+ totes at $22, flat $9 shipping.", g, 40);
      await sleep(900, g);
      idle("codex");

      // a risky step waits for the owner
      $("send-order").disabled = false;
      present("codex", "ready to click Send order, waiting for you", { selector: "#send-order" });
      setState("codex", "waiting", "needs your approval");
      const decision = await askApproval(g);
      alive(g);
      if (decision === "approve") {
        present("codex", "clicking Send order", { selector: "#send-order", claimed: true, claimMs: 2500 });
        await sleep(1200, g);
        $("sent").textContent = "Order sent to the sandbox. Nothing was really sent.";
        feed("You approved. Codex sent the order.", "ok");
      } else {
        present("codex", "understood, holding the order", { selector: "#send-order" });
        feed("You denied. Codex was told no.", "warn");
      }
      await sleep(1500, g);
      for (const k of KEYS) idle(k);
      feed("Scene complete. Try an instruction, or replay.");
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  }

  function askApproval(g) {
    return new Promise((resolve, reject) => {
      const box = $("need");
      box.textContent = "";
      const card = document.createElement("div");
      card.className = "need";
      const p = document.createElement("p");
      p.textContent = "Codex wants to click “Send order” on harborgoods.example. Approve?";
      const row = document.createElement("div");
      row.className = "a";
      const yes = document.createElement("button");
      yes.className = "b go"; yes.type = "button"; yes.textContent = "Approve";
      const no = document.createElement("button");
      no.className = "b"; no.type = "button"; no.textContent = "Deny";
      row.append(yes, no);
      card.append(p, row);
      box.appendChild(card);
      feed("Codex is waiting for your approval.", "warn");
      const done = (d) => { pendingApproval = null; clearNeed(); g === gen ? resolve(d) : reject(new Cancelled()); };
      pendingApproval = () => { clearNeed(); reject(new Cancelled()); };
      yes.addEventListener("click", () => done("approve"));
      no.addEventListener("click", () => done("deny"));
    });
  }
  function clearNeed() {
    $("need").innerHTML = '<div class="empty">Nothing right now. Risky steps will appear here, never inside the page.</div>';
  }

  // ---- owner controls ----
  async function instruct(text) {
    const said = text.trim().slice(0, 140);
    if (!said) return;
    if (pendingApproval) pendingApproval();
    gen += 1;
    const g = gen;
    feed("You: " + said);
    try {
      for (const k of KEYS) idle(k);
      present("claude", "got it, changing course", { selector: "#order-note" });
      await sleep(900, g);
      present("codex", "to Claude: noted, pausing my part", {});
      const shipping = /shipping/i.test(said);
      const line = shipping ? "Owner asked: shipping under $10. Flat $9, OK." : "Owner note: " + said;
      present("claude", "typing the note", { selector: "#order-note", claimed: true, claimMs: 3500 });
      await typeInto($("order-note"), line, g, 38);
      await sleep(700, g);
      present("opencode", shipping ? "verified ✓ $9 flat is under $10" : "verified ✓ note added", { selector: "#order-note" });
      await sleep(1600, g);
      for (const k of KEYS) idle(k);
      feed("Agents adapted to your instruction.", "ok");
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  }
  function stopAll() {
    if (pendingApproval) pendingApproval();
    gen += 1;
    for (const k of KEYS) { overlay.remove(AGENTS[k].name); setState(k, "stopped", "stopped by owner"); }
    $("send-order").disabled = true;
    $("clock").textContent = "stopped";
    feed("Owner pressed Stop all. Every agent was told to stop.", "stop");
  }
  function restart() {
    if (pendingApproval) pendingApproval();
    gen += 1;
    for (const k of KEYS) overlay.remove(AGENTS[k].name);
    $("order-number").value = ""; $("order-note").value = ""; $("sent").textContent = "";
    $("feed").textContent = ""; $("clock").textContent = "running";
    document.getElementById("page").scrollTo({ top: 0 });
    for (const k of KEYS) state[k] = { status: "idle", doing: "" };
    startedAt = Date.now();
    renderRoster();
    play(gen);
  }

  $("cmdform").addEventListener("submit", (e) => { e.preventDefault(); const i = $("cmd"); const v = i.value; i.value = ""; $("clock").textContent = "running"; instruct(v); });
  document.querySelectorAll("[data-say]").forEach((b) => b.addEventListener("click", () => { $("clock").textContent = "running"; instruct(b.getAttribute("data-say")); }));
  $("stop").addEventListener("click", stopAll);
  $("restart").addEventListener("click", restart);
  $("send-order").addEventListener("click", () => {});

  for (const k of KEYS) state[k] = { status: "idle", doing: "" };
  renderRoster();
  play(gen);
})();
