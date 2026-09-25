// The overlay UI. It draws ~/.m9r/feed.json and nothing else: no logic about tasks, approvals or agents lives here.
// Every string from the feed is placed with textContent, never as HTML.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

type AgentState = "open_working" | "open_idle" | "offline" | "unknown" | "seen" | "not_connected";
interface Agent { handle: string; state: AgentState; since?: string; evidence: string; sessions: Array<{ id: string; cwd?: string; live: boolean | null }> }
type NeedsYou =
  | { kind: "approval"; taskId: string; from: string; to: string; goal: string; protected: boolean }
  | { kind: "push_failed"; taskId: string; from: string; fromSession?: string; to: string; reason: string; fix: string; linkable: boolean }
  | { kind: "answer"; taskId: string; from: string; summary: string };
interface Ping { id: number; kind: string; taskId: string; text: string }
interface InProgress { taskId: string; from: string; to: string; goal: string; state: "queued" | "waiting_prompt" | "working"; since: string }
type WebKind = "action" | "message" | "blocked" | "worker";
/** What agents did or said on real web pages, newest first. Optional: older engines do not write it. */
interface WebEvent { at: string; agent: string; provider: string; kind: WebKind; text: string; tab?: string; url?: string }
interface Feed { version: 1; seq: number; agents: Agent[]; needsYou: NeedsYou[]; inProgress?: InProgress[]; recent: Array<{ at: string; taskId?: string; text: string }>; pings: Ping[]; web?: WebEvent[] }

const COLLAPSED = { w: 220, h: 36 };
const WIDE = 360;
const PING_MS = 6000;
const PANEL_MAX_H = 560;
/** How many agent marks fit on the collapsed pill beside the mark and the badge; the rest fold into "+n". */
const MAX_MARKS = 4;
/** A web event this recent still colours its agent's ring: working for any activity, blocked when the newest one was a block. */
const WORKING_MS = 60_000;
const BLOCKED_MS = 120_000;
const inTauri = "__TAURI_INTERNALS__" in window;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pill = $("pill"), dots = $("dots"), pingEl = $("ping"), badge = $("badge"), panel = $("panel"), mark = $("mark"), root = $("root");

let feed: Feed | null = null;
let engineStale = false;
let expanded = false;
let dnd = false;
let pingUntil = 0;
let pingTimer: number | undefined;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked; pings then repeat once after a restart, which is harmless */ } },
};

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const STATE_LABEL: Record<AgentState, string> = { open_working: "working", open_idle: "open, idle", offline: "offline", unknown: "unknown", seen: "seen", not_connected: "not connected" };
const hhmm = (iso?: string) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; };
const stateText = (a: Agent) => (a.state === "seen" ? `seen ${hhmm(a.since)}`.trim() : STATE_LABEL[a.state]);

type Provider = "claude" | "codex" | "opencode" | "agent";
const PROVIDER_NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", agent: "Agent" };
const providerOf = (s: string): Provider => {
  const v = s.toLowerCase();
  if (/claude|anthropic/.test(v)) return "claude";
  if (/codex|openai/.test(v)) return "codex";
  if (/opencode/.test(v)) return "opencode";
  return "agent";
};
const handleOf = (s: string) => s.replace(/^@/, "").trim().toLowerCase();

/** The provider's own mark, drawn as a mask so it takes the surface's ink colour. */
function logo(provider: Provider, cls = "chip") {
  const chip = el("span", cls);
  chip.append(el("span", `logo p-${provider}`));
  return chip;
}

/** Only well-formed entries: the feed is data from another process and a bad row must not break the pill. */
function webEvents(): WebEvent[] {
  const w = feed?.web;
  if (!Array.isArray(w)) return [];
  return w.filter((e): e is WebEvent => !!e && typeof e.agent === "string" && typeof e.text === "string" && typeof e.at === "string" && ["action", "message", "blocked", "worker"].includes(e.kind)).slice(0, 30);
}

type Ring = "blocked" | "waiting" | "working" | "idle" | "off";
const RING_LABEL: Record<Ring, string> = { blocked: "blocked", waiting: "waiting for you", working: "working", idle: "open, idle", off: "not active" };
interface Presence { key: string; provider: Provider; state: AgentState | "web"; ring: Ring; label: string }

/** One entry per agent, from the agents list and from anyone acting on the web, with the ring that best says what it is doing now. */
function presence(): Presence[] {
  const now = Date.now();
  const web = webEvents();
  const out = new Map<string, Presence>();
  for (const a of feed?.agents ?? []) {
    const ring: Ring = a.state === "open_working" ? "working" : a.state === "open_idle" || a.state === "seen" ? "idle" : "off";
    out.set(handleOf(a.handle), { key: handleOf(a.handle), provider: providerOf(a.handle), state: a.state, ring, label: `@${a.handle}: ${stateText(a)}` });
  }
  const latest = new Map<string, WebEvent>();
  for (const e of web) { const k = handleOf(e.agent); if (!latest.has(k)) latest.set(k, e); }
  for (const [k, e] of latest) {
    const age = now - Date.parse(e.at);
    const p = out.get(k) ?? { key: k, provider: providerOf(e.provider || e.agent), state: "web" as const, ring: "off" as Ring, label: "" };
    if (e.provider) p.provider = providerOf(e.provider);
    if (e.kind === "blocked" && age < BLOCKED_MS) p.ring = "blocked";
    else if (age < WORKING_MS && p.ring !== "blocked") p.ring = "working";
    out.set(k, p);
  }
  const waitingOn = new Set<string>();
  for (const n of feed?.needsYou ?? []) if (n.kind === "approval" && !locallyDismissed.has(n.taskId)) waitingOn.add(handleOf(n.from));
  for (const p of feed?.inProgress ?? []) if (p.state === "working") { const x = out.get(handleOf(p.to)); if (x && x.ring !== "blocked") x.ring = "working"; }
  for (const k of waitingOn) { const x = out.get(k); if (x && x.ring !== "blocked") x.ring = "waiting"; }
  for (const p of out.values()) p.label = `@${p.key} (${PROVIDER_NAME[p.provider]}): ${RING_LABEL[p.ring]}`;
  return [...out.values()];
}

/** Reconciled by key, not rebuilt, so a ring change is a transition and not a flash. */
function drawDots() {
  const all = presence();
  const shown = all.slice(0, MAX_MARKS);
  const byKey = new Map(Array.from(dots.querySelectorAll<HTMLElement>(".dot")).map((d) => [d.dataset.key ?? "", d] as const));
  const next: HTMLElement[] = shown.map((p) => {
    let d = byKey.get(p.key);
    if (!d || d.dataset.provider !== p.provider) { d = logo(p.provider, "dot"); d.dataset.key = p.key; d.dataset.provider = p.provider; }
    d.className = `dot ${p.state}`;
    d.dataset.ring = p.ring;
    d.title = p.label;
    d.setAttribute("aria-label", p.label);
    return d;
  });
  if (all.length > shown.length) next.push(el("span", "more", `+${all.length - shown.length}`));
  // Move nodes only where the order changed: a detached node loses its style, and with it the transition.
  next.forEach((n, i) => { if (dots.children[i] !== n) dots.insertBefore(n, dots.children[i] ?? null); });
  while (dots.children.length > next.length) dots.lastElementChild?.remove();
}

function drawMark() {
  mark.classList.toggle("stale", engineStale);
  mark.title = engineStale ? "M9R engine seems stopped; it will restart itself, or reopen the overlay." : "";
}

function drawBadge() {
  const n = feed?.needsYou.filter((x) => !locallyDismissed.has(x.taskId)).length ?? 0;
  const busy = feed?.inProgress?.filter((x) => !locallyDismissed.has(x.taskId)).length ?? 0;
  // Something needs you: the filled badge. Otherwise, if work is under way, a hollow badge with a pulse, so a pause reads as progress.
  badge.hidden = n === 0 && busy === 0;
  badge.textContent = String(n > 0 ? n : busy);
  badge.classList.toggle("wait", n === 0 && busy > 0);
}

const secs = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

function progressRow(p: InProgress) {
  const row = el("div", "row");
  const main = el("div", "main");
  main.append(el("div", "title", `@${p.from} → @${p.to}: ${p.goal}`));
  const what = p.state === "queued" ? `Queued in @${p.to}, waiting for it to pick up` : p.state === "waiting_prompt" ? `Waiting for @${p.to}'s next prompt` : `@${p.to} is working on it`;
  main.append(el("div", "sub progress", `${what} · ${secs(p.since)} s`));
  row.append(main, dismissButton(p.taskId));
  return row;
}

function section(title: string, rows: HTMLElement[], emptyText: string) {
  const wrap = el("div");
  wrap.append(el("h3", undefined, title));
  if (rows.length === 0) wrap.append(el("div", "empty", emptyText)); else wrap.append(...rows);
  return wrap;
}

type Approval = Extract<NeedsYou, { kind: "approval" }>;
/** Results of clicks, kept until the feed drops the task so the row says what happened instead of going quiet. */
const decided = new Map<string, { ok: boolean; text: string; title: string }>();
const linkedResults = new Map<string, { ok: boolean; text: string }>();
/**
 * Rows the person cleared with the row's own "x", hidden locally the instant they click it. The backend dismiss
 * is fire-and-forget (a stale item with no natural close action was the actual complaint -- clearing it should
 * never wait on a round trip), and this set is reconciled against the feed once it catches up, so nothing lingers
 * forever if the engine call happens to fail.
 */
const locallyDismissed = new Set<string>();

/** A small "x" in a row's corner: clears it from the overlay's own lists without touching the task itself. */
function dismissButton(taskId: string) {
  const b = el("button", "dismiss", "×") as HTMLButtonElement;
  b.setAttribute("aria-label", "Dismiss");
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    locallyDismissed.add(taskId);
    render();
    void invoke("dismiss_task", { taskId }).catch(() => { locallyDismissed.delete(taskId); render(); });
  });
  return b;
}
/** Sessions fetched for one agent while a link picker is open, so re-render does not refetch it every 3 s. */
const sessionCache = new Map<string, { at: number; rows: Array<{ sessionId: string; cwd?: string; lastSeenAt: string }> }>();

type PushFailed = Extract<NeedsYou, { kind: "push_failed" }>;

/** "Link a session" for a task that could not be pushed: pick which of the target agent's sessions this one should always reach. */
function linkPicker(n: PushFailed) {
  const wrap = el("div", "actions");
  const label = el("button", "link", "Link a session…");
  const list = el("div", "picker");
  list.hidden = true;
  label.addEventListener("click", async () => {
    if (!list.hidden) { list.hidden = true; return; }
    list.replaceChildren(el("div", "sub", "Loading…"));
    list.hidden = false;
    const cached = sessionCache.get(n.to);
    const rows = cached && Date.now() - cached.at < 4000 ? cached.rows : await invoke<string>("list_sessions", { handle: n.to }).then((s) => { const r = JSON.parse(s); sessionCache.set(n.to, { at: Date.now(), rows: r }); return r; }).catch(() => []);
    if (rows.length === 0) { list.replaceChildren(el("div", "sub", `No @${n.to} sessions seen yet.`)); return; }
    list.replaceChildren(...rows.map((r: { sessionId: string; cwd?: string; lastSeenAt: string }) => {
      const item = el("button", "btn picker-item", `${r.cwd ?? "(no folder)"} · ${hhmm(r.lastSeenAt)}`);
      item.addEventListener("click", async () => {
        list.hidden = true;
        try {
          await invoke<string>("link_sessions", { fromHandle: n.from, fromSession: n.fromSession, toHandle: n.to, toSession: r.sessionId });
          linkedResults.set(n.taskId, { ok: true, text: `Linked. Send it again and it will go to that @${n.to} session.` });
        } catch (e) {
          linkedResults.set(n.taskId, { ok: false, text: `Couldn't link: ${String(e).slice(0, 100)}` });
        }
        window.setTimeout(() => { linkedResults.delete(n.taskId); render(); }, 8000);
        render();
      });
      return item;
    }));
  });
  wrap.append(label, list);
  return wrap;
}

function outcomeText(action: string, to: string, out: string): string {
  if (action === "deny") return `Denied. @${to} is told no.`;
  if (/Could not push/i.test(out)) return `Approved, but @${to} isn't reachable now. It gets it at its next prompt.`;
  if (/Pushed into/i.test(out)) return `Approved. Sent to @${to}.`;
  return `Approved. @${to} gets it at its next prompt.`;
}

function actionsFor(n: Approval) {
  const actions = el("div", "actions");
  const buttons: HTMLButtonElement[] = [];
  const run = async (action: "approve" | "deny" | "allow_day") => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const out = await invoke<string>("decide", { taskId: n.taskId, action, from: n.from, to: n.to });
      decided.set(n.taskId, { ok: true, title: `@${n.from} asks @${n.to}: ${n.goal}`, text: action === "allow_day" ? `Approved, and @${n.from} may hand work to @${n.to} for a day.` : outcomeText(action, n.to, out) });
      window.setTimeout(() => { decided.delete(n.taskId); render(); }, 5000);
    } catch (e) {
      decided.set(n.taskId, { ok: false, title: `@${n.from} asks @${n.to}: ${n.goal}`, text: `Couldn't do that: ${String(e).slice(0, 140)}` });
      window.setTimeout(() => { decided.delete(n.taskId); render(); }, 6000);
    }
    render();
  };
  const mk = (label: string, cls: string, action: "approve" | "deny" | "allow_day") => {
    const b = el("button", cls, label) as HTMLButtonElement;
    b.addEventListener("click", () => { void run(action); });
    buttons.push(b);
    return b;
  };
  actions.append(mk(n.protected ? "Approve this once" : "Approve", "btn primary", "approve"), mk("Deny", "btn", "deny"));
  if (!n.protected) { const l = mk("Allow this kind for a day", "link", "allow_day"); actions.append(l); }
  return actions;
}

function needsRow(n: NeedsYou) {
  const row = el("div", "row");
  const main = el("div", "main");
  if (n.kind === "approval") {
    main.append(el("div", "title", `@${n.from} asks @${n.to}: ${n.goal}`));
    if (n.protected) main.append(el("div", "tag", "ALWAYS ASKS"), el("div", "sub", "Approving covers this one action only."));
    const done = decided.get(n.taskId);
    if (done) main.append(el("div", done.ok ? "result ok" : "result bad", done.text));
    else main.append(actionsFor(n));
  } else if (n.kind === "push_failed") {
    main.append(el("div", "title", `${n.taskId} could not be pushed`), el("div", "sub", n.reason), ...(n.fix ? [el("div", "sub", n.fix)] : []));
    const linked = linkedResults.get(n.taskId);
    if (linked) main.append(el("div", linked.ok ? "result ok" : "result bad", linked.text));
    else if (n.linkable) main.append(linkPicker(n));
  } else {
    main.append(el("div", "title", `@${n.from} answered ${n.taskId}`), el("div", "sub", n.summary));
  }
  row.append(main, dismissButton(n.taskId));
  return row;
}

/** A decided task leaves the feed within a moment; keep its row a few seconds so the answer to your click is readable. */
function ghostRows(live: NeedsYou[]) {
  const ids = new Set(live.filter((n) => n.kind === "approval").map((n) => (n as Approval).taskId));
  return [...decided].filter(([id]) => !ids.has(id)).map(([, d]) => { const row = el("div", "row"), main = el("div", "main"); main.append(el("div", "title", d.title), el("div", d.ok ? "result ok" : "result bad", d.text)); row.append(main); return row; });
}

type LiveFilter = "all" | "message" | "blocked";
let liveFilter: LiveFilter = "all";
/** Events already drawn once; only the ones after that get the entrance, so a 3 s redraw never replays it. */
let seenLive = new Set<string>();
let liveDrawn = false;
const liveKey = (e: WebEvent) => `${e.at}|${e.agent}|${e.kind}|${e.text}`;

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return hhmm(iso);
};
const hostOf = (url?: string) => { if (!url) return ""; try { return new URL(url).host; } catch { return ""; } };
/** "claude to codex: text" -> addressing and body, so the message reads as one agent speaking to another. */
const MESSAGE = /^@?([\w.-]+)\s+(?:to|→|->)\s+@?([\w.-]+)\s*:\s*([\s\S]+)$/i;

function liveItem(e: WebEvent, fresh: boolean) {
  const item = el("div", `live-item k-${e.kind}${fresh ? " fresh" : ""}`);
  const head = el("div", "head");
  let body = e.text;
  head.append(el("span", "who", handleOf(e.agent)));
  if (e.kind === "message") {
    const m = MESSAGE.exec(e.text);
    if (m && handleOf(m[1]) === handleOf(e.agent)) { head.append(el("span", "to", `to ${m[2]}`)); body = m[3]; }
    else head.append(el("span", "to", "says"));
  } else if (e.kind === "blocked") {
    head.append(el("span", "tag blocked", "Blocked"));
    body = body.replace(/^blocked:\s*/i, "");
  } else if (e.kind === "worker") {
    head.append(el("span", "tag", "Worker"));
  }
  const when = el("time", "when", ago(e.at));
  const d = new Date(e.at);
  if (!Number.isNaN(d.getTime())) { when.setAttribute("datetime", e.at); when.title = d.toLocaleString(); }
  head.append(when);
  const main = el("div", "body");
  main.append(head, el("div", "text", body));
  const where = [e.tab, hostOf(e.url)].filter(Boolean).join(" · ");
  if (where) { const w = el("div", "where", where); if (e.url) w.title = e.url; main.append(w); }
  item.append(logo(providerOf(e.provider || e.agent)), main);
  return item;
}

function liveSection(events: WebEvent[]) {
  const wrap = el("div", "live");
  const top = el("div", "live-top");
  top.append(el("h3", undefined, "Live"));
  const counts: Record<LiveFilter, number> = { all: events.length, message: events.filter((e) => e.kind === "message").length, blocked: events.filter((e) => e.kind === "blocked").length };
  const seg = el("div", "seg");
  seg.setAttribute("role", "tablist");
  for (const [f, label] of [["all", "All"], ["message", "Messages"], ["blocked", "Blocked"]] as Array<[LiveFilter, string]>) {
    const b = el("button", `seg-btn${liveFilter === f ? " on" : ""}`) as HTMLButtonElement;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(liveFilter === f));
    b.append(el("span", undefined, label), el("span", "n", String(counts[f])));
    b.addEventListener("click", () => { liveFilter = f; drawPanel(); fit(); });
    seg.append(b);
  }
  top.append(seg);
  wrap.append(top);
  const shown = liveFilter === "all" ? events : events.filter((e) => e.kind === liveFilter);
  if (shown.length === 0) {
    wrap.append(el("div", "empty", liveFilter === "blocked" ? "Nothing is blocked." : liveFilter === "message" ? "No messages between agents yet." : "No agents on the web right now."));
  } else {
    const list = el("div", "live-list");
    list.append(...shown.map((e) => liveItem(e, liveDrawn && !seenLive.has(liveKey(e)))));
    wrap.append(list);
  }
  seenLive = new Set(events.map(liveKey));
  liveDrawn = true;
  return wrap;
}

function drawPanel() {
  if (!feed || !expanded) { panel.hidden = true; panel.replaceChildren(); return; }
  const scroll = panel.scrollTop;
  panel.hidden = false;
  const rings = new Map(presence().map((p) => [p.key, p.ring]));
  const agents = feed.agents.map((a) => {
    const row = el("div", "row agent");
    const chip = logo(providerOf(a.handle));
    chip.dataset.ring = rings.get(handleOf(a.handle)) ?? "off";
    row.append(chip);
    const main = el("div", "main");
    main.append(el("div", "title", `@${a.handle} · ${stateText(a)}`), el("div", "sub", a.sessions[0]?.cwd ?? a.evidence));
    row.append(main); return row;
  });
  const recent = feed.recent.slice(0, 6).map((r) => { const row = el("div", "row"); const main = el("div", "main"); main.append(el("div", "sub", `${hhmm(r.at)}  ${r.text}`)); row.append(main); return row; });
  const needsYou = feed.needsYou.filter((n) => !locallyDismissed.has(n.taskId));
  const inProgress = (feed.inProgress ?? []).filter((p) => !locallyDismissed.has(p.taskId));
  // Reconcile: once the feed itself no longer has a dismissed id, the round trip is done -- stop tracking it.
  for (const id of locallyDismissed) if (!feed.needsYou.some((n) => n.taskId === id) && !(feed.inProgress ?? []).some((p) => p.taskId === id)) locallyDismissed.delete(id);
  const web = webEvents();
  panel.replaceChildren(
    section("Needs you", [...needsYou.map(needsRow), ...ghostRows(needsYou)], "Nothing needs you."),
    ...(Array.isArray(feed.web) ? [liveSection(web)] : []),
    ...(inProgress.length > 0 ? [section("In progress", inProgress.map(progressRow), "")] : []),
    section("Agents", agents, "No agents seen yet."),
    section("Recent", recent, "No activity yet."),
    el("div", "foot", "M9R overlay · a view of ~/.m9r/feed.json"),
  );
  panel.scrollTop = scroll;
}

/** Asks the window to fit the content: pill only, pill plus a ping line, or pill plus the panel. */
function fit() {
  const pinging = Date.now() < pingUntil && !expanded;
  pill.classList.toggle("pinging", pinging);
  pingEl.hidden = !pinging;
  const width = expanded || pinging ? WIDE : COLLAPSED.w;
  const height = expanded ? Math.min(PANEL_MAX_H, COLLAPSED.h + 6 + panel.offsetHeight + 2) : COLLAPSED.h;
  if (inTauri) void invoke("resize_pill", { width, height }).catch(() => undefined);
  // Browser preview: stand in for the window by sizing the root to what the window would be.
  else { root.style.width = `${width}px`; root.style.height = `${height}px`; }
}

function render() {
  drawDots(); drawBadge(); drawMark(); drawPanel(); fit();
}

function onFeed(next: Feed) {
  const stored = Number(store.get("lastSeq") ?? NaN);
  // A feed whose sequence went backwards was reset (file deleted, state cleared). Treat it like a first run, or pings
  // would stay silent until the new sequence caught up with the old one.
  const previous = !Number.isNaN(stored) && next.seq < stored ? NaN : stored;
  feed = next;
  // First run: whatever is already in the feed counts as seen. After that only newer pings announce themselves.
  const fresh = Number.isNaN(previous) ? [] : next.pings.filter((p) => p.id > previous);
  store.set("lastSeq", String(next.seq));
  if (fresh.length > 0 && !dnd && !expanded) {
    pingEl.textContent = fresh.length > 1 ? `${fresh[0].text}  (+${fresh.length - 1} more)` : fresh[0].text;
    pingUntil = Date.now() + PING_MS;
    window.clearTimeout(pingTimer);
    pingTimer = window.setTimeout(() => { pingUntil = 0; fit(); }, PING_MS);
  }
  render();
}

function parse(text: string) {
  try { const f = JSON.parse(text) as Feed; if (f && f.version === 1 && Array.isArray(f.agents)) onFeed(f); } catch { /* keep the last good feed */ }
}

// Drag the pill from anywhere on it: press and move more than a few pixels and the window follows the mouse; a plain click still
// opens or closes the panel. The window never takes keyboard focus, so this uses the system's own window drag.
let press: { x: number; y: number } | null = null;
let dragged = false;
pill.addEventListener("mousedown", (ev) => { if (ev.button === 0) { press = { x: ev.screenX, y: ev.screenY }; dragged = false; } });
window.addEventListener("mouseup", () => { press = null; });
window.addEventListener("mousemove", (ev) => {
  if (!press || !inTauri || (ev.buttons & 1) === 0) return;
  if (Math.hypot(ev.screenX - press.x, ev.screenY - press.y) < 5) return;
  press = null;
  dragged = true;
  void getCurrentWindow().startDragging().catch(() => undefined);
});

pill.addEventListener("click", () => {
  if (dragged) { dragged = false; return; }
  expanded = !expanded;
  if (expanded) { pingUntil = 0; window.clearTimeout(pingTimer); }
  render();
});
// Keep the "· 12 s" and "40s" counters moving while the panel is open, and let rings settle as web activity ages.
window.setInterval(() => {
  drawDots();
  if (expanded && ((feed?.inProgress?.length ?? 0) > 0 || webEvents().length > 0)) drawPanel();
}, 3000);

window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && expanded) { expanded = false; render(); } });

/** Preview only: shift every ISO time in the mock feed by the same amount so it reads as happening now. */
function freshen(text: string) {
  try {
    const f = JSON.parse(text) as Feed;
    const newest = Date.parse(f.web?.[0]?.at ?? f.recent?.[0]?.at ?? "");
    if (Number.isNaN(newest)) return text;
    const shift = Date.now() - 4000 - newest;
    const move = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(Date.parse(iso) + shift).toISOString() : iso);
    f.web?.forEach((e) => { e.at = move(e.at) ?? e.at; });
    f.recent.forEach((r) => { r.at = move(r.at) ?? r.at; });
    f.inProgress?.forEach((p) => { p.since = move(p.since) ?? p.since; });
    f.agents.forEach((a) => { a.since = move(a.since); });
    return JSON.stringify(f);
  } catch { return text; }
}

async function start() {
  if (inTauri) {
    await listen<string>("feed", (e) => parse(e.payload));
    await listen("feed-missing", () => { feed = null; render(); });
    await listen("engine-stale", () => { engineStale = true; render(); });
    await listen("engine-ok", () => { engineStale = false; render(); });
    await listen<boolean>("dnd", (e) => { dnd = e.payload; });
    const initial = await invoke<string | null>("read_feed").catch(() => null);
    if (initial) parse(initial);
  } else {
    // Browser preview (`npm run ui`): draw the mock feed so the design can be checked without the window.
    document.body.classList.add("preview");
    // Its timestamps are moved so the newest event is a few seconds old, or every ring would read as long idle.
    const res = await fetch("/mock-feed.json").catch(() => null);
    if (res?.ok) parse(freshen(await res.text()));
  }
  render();
}
void start();
