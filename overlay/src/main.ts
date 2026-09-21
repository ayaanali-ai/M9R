// The overlay UI. It draws ~/.m9r/feed.json and nothing else: no logic about tasks, approvals or agents lives here.
// Every string from the feed is placed with textContent, never as HTML.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type AgentState = "open_working" | "open_idle" | "offline" | "unknown" | "seen" | "not_connected";
interface Agent { handle: string; state: AgentState; since?: string; evidence: string; sessions: Array<{ id: string; cwd?: string; live: boolean | null }> }
type NeedsYou =
  | { kind: "approval"; taskId: string; from: string; to: string; goal: string; protected: boolean }
  | { kind: "push_failed"; taskId: string; to: string; reason: string; fix: string }
  | { kind: "answer"; taskId: string; from: string; summary: string };
interface Ping { id: number; kind: string; taskId: string; text: string }
interface Feed { version: 1; seq: number; agents: Agent[]; needsYou: NeedsYou[]; recent: Array<{ at: string; taskId?: string; text: string }>; pings: Ping[] }

const COLLAPSED = { w: 220, h: 36 };
const WIDE = 340;
const PING_MS = 6000;
const PANEL_MAX_H = 520;
const inTauri = "__TAURI_INTERNALS__" in window;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pill = $("pill"), dots = $("dots"), pingEl = $("ping"), badge = $("badge"), panel = $("panel");

let feed: Feed | null = null;
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

function drawDots() {
  dots.replaceChildren(...(feed?.agents ?? []).map((a) => { const d = el("span", `dot ${a.state}`); d.title = `@${a.handle}: ${stateText(a)}`; return d; }));
}

function drawBadge() {
  const n = feed?.needsYou.length ?? 0;
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

function section(title: string, rows: HTMLElement[], emptyText: string) {
  const wrap = el("div");
  wrap.append(el("h3", undefined, title));
  if (rows.length === 0) wrap.append(el("div", "empty", emptyText)); else wrap.append(...rows);
  return wrap;
}

function needsRow(n: NeedsYou) {
  const row = el("div", "row");
  const main = el("div", "main");
  if (n.kind === "approval") {
    main.append(el("div", "title", `@${n.from} asks @${n.to}: ${n.goal}`));
    if (n.protected) main.append(el("div", "tag", "PROTECTED ACTION: ALWAYS ASKS"));
    const actions = el("div", "actions");
    for (const label of ["Approve", "Deny"]) { const b = el("button", "btn", label) as HTMLButtonElement; b.disabled = true; b.title = `Deciding from the overlay arrives in a later step. For now: m9r-cli ${label.toLowerCase()} ${n.taskId}`; actions.append(b); }
    main.append(actions);
  } else if (n.kind === "push_failed") {
    main.append(el("div", "title", `${n.taskId} could not be pushed`), el("div", "sub", n.reason), el("div", "sub", n.fix));
  } else {
    main.append(el("div", "title", `@${n.from} answered ${n.taskId}`), el("div", "sub", n.summary));
  }
  row.append(main);
  return row;
}

function drawPanel() {
  if (!feed || !expanded) { panel.hidden = true; panel.replaceChildren(); return; }
  panel.hidden = false;
  const agents = feed.agents.map((a) => {
    const row = el("div", "row"); row.append(el("span", `dot ${a.state}`));
    const main = el("div", "main");
    main.append(el("div", "title", `@${a.handle} · ${stateText(a)}`), el("div", "sub", a.sessions[0]?.cwd ?? a.evidence));
    row.append(main); return row;
  });
  const recent = feed.recent.slice(0, 6).map((r) => { const row = el("div", "row"); const main = el("div", "main"); main.append(el("div", "sub", `${hhmm(r.at)}  ${r.text}`)); row.append(main); return row; });
  panel.replaceChildren(
    section("Needs you", feed.needsYou.map(needsRow), "Nothing needs you."),
    section("Agents", agents, "No agents seen yet."),
    section("Recent", recent, "No activity yet."),
    el("div", "foot", "M9R overlay · a view of ~/.m9r/feed.json"),
  );
}

/** Asks the window to fit the content: pill only, pill plus a ping line, or pill plus the panel. */
function fit() {
  const pinging = Date.now() < pingUntil && !expanded;
  pill.classList.toggle("pinging", pinging);
  pingEl.hidden = !pinging;
  const width = expanded || pinging ? WIDE : COLLAPSED.w;
  const height = expanded ? Math.min(PANEL_MAX_H, COLLAPSED.h + 6 + panel.offsetHeight + 2) : COLLAPSED.h;
  if (inTauri) void invoke("resize_pill", { width, height }).catch(() => undefined);
}

function render() {
  drawDots(); drawBadge(); drawPanel(); fit();
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

pill.addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).classList.contains("mark")) return; // the mark is the drag handle
  expanded = !expanded;
  if (expanded) { pingUntil = 0; window.clearTimeout(pingTimer); }
  render();
});
window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && expanded) { expanded = false; render(); } });

async function start() {
  if (inTauri) {
    await listen<string>("feed", (e) => parse(e.payload));
    await listen("feed-missing", () => { feed = null; render(); });
    await listen<boolean>("dnd", (e) => { dnd = e.payload; });
    const initial = await invoke<string | null>("read_feed").catch(() => null);
    if (initial) parse(initial);
  } else {
    // Browser preview (`npm run ui`): draw the mock feed so the design can be checked without the window.
    const res = await fetch("/mock-feed.json").catch(() => null);
    if (res?.ok) parse(await res.text());
  }
  render();
}
void start();
