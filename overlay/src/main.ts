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
interface Feed { version: 1; seq: number; agents: Agent[]; needsYou: NeedsYou[]; inProgress?: InProgress[]; recent: Array<{ at: string; taskId?: string; text: string }>; pings: Ping[] }

const COLLAPSED = { w: 220, h: 36 };
const WIDE = 340;
const PING_MS = 6000;
const PANEL_MAX_H = 520;
const inTauri = "__TAURI_INTERNALS__" in window;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pill = $("pill"), dots = $("dots"), pingEl = $("ping"), badge = $("badge"), panel = $("panel"), mark = $("mark");

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

function drawDots() {
  dots.replaceChildren(...(feed?.agents ?? []).map((a) => { const d = el("span", `dot ${a.state}`); d.title = `@${a.handle}: ${stateText(a)}`; return d; }));
}

function drawMark() {
  mark.classList.toggle("stale", engineStale);
  mark.title = engineStale ? "M9R engine seems stopped; it will restart itself, or reopen the overlay." : "";
}

function drawBadge() {
  const n = feed?.needsYou.length ?? 0;
  const busy = feed?.inProgress?.length ?? 0;
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
  row.append(main);
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
  row.append(main);
  return row;
}

/** A decided task leaves the feed within a moment; keep its row a few seconds so the answer to your click is readable. */
function ghostRows(live: NeedsYou[]) {
  const ids = new Set(live.filter((n) => n.kind === "approval").map((n) => (n as Approval).taskId));
  return [...decided].filter(([id]) => !ids.has(id)).map(([, d]) => { const row = el("div", "row"), main = el("div", "main"); main.append(el("div", "title", d.title), el("div", d.ok ? "result ok" : "result bad", d.text)); row.append(main); return row; });
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
    section("Needs you", [...feed.needsYou.map(needsRow), ...ghostRows(feed.needsYou)], "Nothing needs you."),
    ...((feed.inProgress?.length ?? 0) > 0 ? [section("In progress", (feed.inProgress ?? []).map(progressRow), "")] : []),
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
// Keep the "· 12 s" counters moving while work is under way and the panel is open.
window.setInterval(() => { if (expanded && (feed?.inProgress?.length ?? 0) > 0) { const y = panel.scrollTop; drawPanel(); panel.scrollTop = y; } }, 3000);

window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && expanded) { expanded = false; render(); } });

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
    const res = await fetch("/mock-feed.json").catch(() => null);
    if (res?.ok) parse(await res.text());
  }
  render();
}
void start();
