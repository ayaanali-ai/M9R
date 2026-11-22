// Island views: overview (agents sidebar plus the selected agent's activity), error, finished, message composer (approvals
// render inline there, not as a separate screen), settings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { providerLogo } from "./provider";
import { buildPrompt } from "./composer";
import { buddy } from "./buddy";
import { State, PROVIDER_COLORS, type AgentTask, type ChatMessage, type LinkOffer, type Settings } from "../core/state";
import type { SessionRow } from "../core/transport";
import type { SpeechEnv } from "../core/speech";
import { washRGBA, botGlowColor, type IslandViewName, type Wash } from "../core/layout";
import { plainStep, plainStatus, displayName, approvalSentence } from "../core/humanize";
import { buildSettingsDrum } from "./settings-drum";
import { dotSlider } from "./dot-slider";

export interface ViewActions {
  setOwnerWorkMode?(mode: "working" | "agents-free"): Promise<void>;
  setView(v: IslandViewName): void;
  collapse(): void;
  focusWindow?(focused: boolean): void;
  setFocus(id: string): void;
  /** Open Muse's avatar panel (Activity / Approvals / Identity / Inbox) for this agent, or the
   * focused one. Idempotent: it never toggles closed, so every avatar click reliably shows it. */
  openIdentity(id?: string): void;
  closeIdentity(): void;
  /** approvalId defaults to the oldest pending approval; pass it explicitly when more than one
   * card can be on screen at once (the chat log can show several at a time). */
  decide(d: "allow" | "deny" | "allow_day", approvalId?: string): void;
  send(text: string): Promise<string | void>;
  /** Present only when the host can save to shared memory (the in-page pill). */
  saveMemory?(text: string): Promise<void>;
  dismissTask?(taskId: string): Promise<void>;
  selectModel?(handle: string, model: string | null, effort: string | null): Promise<void>;
  canAllowForADay(): boolean;
  /** Present only when the host has speech recognition (the page frame); hold the mic to talk. */
  dictation?: () => SpeechEnv;
  /** Present only when the host can link sessions (the desktop shell). */
  linking?: {
    list(handle: string): Promise<SessionRow[]>;
    link(offer: LinkOffer, toSession: string): Promise<void>;
  };
  toggleSound(): void;
  toggleSettings(): void;
  updateSettings(patch: Partial<Settings>): void;
  setAutoClose(seconds: number): void;
  blip(): void;
  /** Fill the pill window, or restore the size from before. */
  toggleMaximize?(): void;
  isMaximized?(): boolean;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active; used for a lazy local-state refresh. */
  activate?(): void;
  /** Called when the view is hidden or replaced. */
  deactivate?(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Push-to-talk from the keyboard (the message view only). */
  talk?(active: boolean): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while `tick` still has motion to finish; keeps the frame loop alive until it does. */
  readonly animating?: boolean;
  /** Measured, capped draft area used by the prompt island's existing geometry animation. */
  readonly draftHeight?: number;
}

// ── Shared pieces ────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(label: string, kind: "primary" | "secondary", onClick: () => void, kbd?: string): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** Coloured dot + agent name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) row.append(dot(task.color, 8), h("span", { class: "n", text: `@${task.name}` }));
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ───────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  let changingMode = false;
  const workMode = h("button", { title: "Choose whether agents may use foreground input", onclick: async () => {
    if (!actions.setOwnerWorkMode || changingMode) return;
    changingMode = true; workMode.disabled = true;
    try { await actions.setOwnerWorkMode(State.ownerWorkMode === "working" ? "agents-free" : "working"); }
    catch { workMode.title = "Work mode could not be changed. Try again when M9R is connected."; }
    finally { changingMode = false; workMode.disabled = false; }
  } });
  const msgBtn = h("button", { class: "tab", title: "Messages", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabHome = h("button", { class: "tab", title: "Agents", onclick: () => go("overview") }, svg(ICONS.house, 13));
  // Minimizes the pill, from whichever view is open. A plain click target, not a visual
  // control -- Messages/Settings each have their own icon now, so this never needs to show
  // or do anything else.
  const toggle = h("button", { class: "pill-toggle", type: "button", onclick: () => actions.collapse() });
  const brokerStatus = h("span", { class: "broker-status", role: "status", "aria-live": "polite" });
  const soundBtn = h("button", { title: "Sound", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOff, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    // One interface: every page (chats, agents, apps, settings) and the sound toggle live on the
    // rail now. The header keeps only the minimize target and the broker's offline status.
    toggle,
    h("div", { class: "header-actions" }, brokerStatus, workMode),
  );
  void msgBtn; void tabHome;

  return {
    el,
    sync() {
      // Hidden for now: not wired into actual foreground-approval gating the
      // way the UI implies, and the real "agents-free" state is set directly
      // in ~/.m9r/owner-work-mode.json for now, not through this toggle.
      workMode.hidden = true;
      workMode.textContent = State.ownerWorkMode === "working" ? "I'm Working" : "Agents Free";
      workMode.setAttribute("aria-pressed", String(State.ownerWorkMode === "agents-free"));
      workMode.title = State.ownerWorkMode === "working" ? "Background work continues. Foreground turns need your approval." : "Agents may use foreground input. Click to protect your current work.";
      const v = State.view;
      msgBtn.classList.toggle("on", v === "prompt");
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      toggle.title = "Minimize pill";
      toggle.setAttribute("aria-label", "Minimize pill");
      const connection = State.brokerConnection;
      brokerStatus.textContent = connection === "connecting" ? "Connecting" : connection === "disconnected" ? "Offline" : "";
      brokerStatus.dataset.state = connection;
      brokerStatus.title = connection === "disconnected" ? "The M9R browser broker is disconnected" : "Connecting to the M9R browser broker";
      brokerStatus.style.display = connection === "connecting" || connection === "disconnected" ? "inline-flex" : "none";
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
    },
  };
}

// ── Overview (home) ──────────────────────────────────────────────
// Two panes, HeyClicky's home structure: a sidebar of agents as conversations on the left, and on the right either an
// idle greeting or the selected agent's own activity. Everything shown comes from State; nothing is sampled or invented.

/** Messages in the shared thread that this agent sent or was sent, oldest first. */
function agentMessages(task: AgentTask): ChatMessage[] {
  return State.chatHistory.filter((m) => m.from === task.name || m.to === task.name);
}

/** A thread message as plain text: the store prefixes agent replies with "handle: ", which the row already names. */
function messageText(m: ChatMessage): string {
  const prefix = m.from && m.role === "assistant" ? `${m.from}: ` : "";
  const text = prefix && m.content.startsWith(prefix) ? m.content.slice(prefix.length) : m.content;
  return text.replace(/\s+/g, " ").trim();
}

/** The row's one-line preview: the last message involving the agent, else its latest plain-language step. */
function agentPreview(task: AgentTask): string {
  const last = agentMessages(task).at(-1);
  if (last) return (last.role === "user" ? "You: " : "") + messageText(last);
  return plainStep(task, task.steps.at(-1));
}

function shortTime(at: number, now = Date.now()): string {
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short" });
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  if (hour >= 17 && hour < 22) return "Good evening.";
  return "Up late.";
}

/** The desktop shell's hold-to-talk hotkey is Ctrl+Alt held on its own (overlay/src-tauri/src/ctrl_alt_hold.rs). */
const HOLD_HINT = "Hold Ctrl + Alt and tell me what to take off your plate.";

const CONNECTION_LABEL: Record<typeof State.brokerConnection, string> = {
  connected: "Connected", connecting: "Connecting", disconnected: "Offline", unknown: "Local",
};

/** "2 working · 1 needs you", from the live agent states. */
function teamSummary(): string {
  const tasks = State.tasks;
  if (!tasks.length) return "No agents connected yet. Send a message to get one started.";
  const needs = tasks.filter((t) => t.state === "approval").length;
  const busy = tasks.filter((t) => t.runState === "working" || t.runState === "starting" || t.runState === "waiting").length;
  const parts = [`${tasks.length} agent${tasks.length === 1 ? "" : "s"} connected`];
  if (busy) parts.push(`${busy} working`);
  if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} you`);
  return `${parts.join(" · ")}. Pick one to see what it's doing.`;
}

const HOME_RANK: Record<AgentTask["runState"], number> = {
  blocked: 0, failed: 1, working: 2, starting: 3, waiting: 3, idle: 4, seen: 4, stopped: 5, unknown: 6, not_connected: 7,
};

function buildOverview(actions: ViewActions): ViewHost {
  // Sidebar, top to bottom as in HeyClicky's home: home button, search + new, agent faces, conversations, apps, account.
  const homeBtn = h("button", { class: "home-home", type: "button", title: "Home", "aria-label": "Home", onclick: () => { actions.blip(); select(null); } }, svg(ICONS.house, 13));
  const search = h("input", { class: "home-search-input", type: "text", placeholder: "Search", "aria-label": "Search agents" }) as HTMLInputElement;
  const searchGroup = h("label", { class: "home-search" }, svg(ICONS.search, 11, { stroke: 2.2 }), search);
  const newBtn = h("button", { class: "home-new", type: "button", title: "New message", "aria-label": "New message", onclick: () => {
    actions.blip(); State.composeTo = null; actions.setView("prompt");
  } }, svg(ICONS.plus, 12));
  const avatars = h("div", { class: "home-avatars", role: "group", "aria-label": "Active agents" });
  const rows = h("div", { class: "home-rows", role: "listbox", "aria-label": "Conversations" });
  const acctAvatar = h("span", { class: "home-acct-avatar", text: "M" });
  const acctStatus = h("span", { class: "home-acct-status" });
  const account = h("div", { class: "home-acct" },
    acctAvatar,
    h("span", { class: "home-acct-text" }, h("span", { class: "home-acct-name", text: "M9R on this computer" }), acctStatus),
    h("button", { class: "home-acct-gear", type: "button", title: "Settings", "aria-label": "Settings", onclick: () => { actions.blip(); actions.toggleSettings(); } }, svg(ICONS.gearFill, 14)),
  );
  const side = h("aside", { class: "home-side" },
    h("div", { class: "home-side-top" }, homeBtn),
    h("div", { class: "home-search-row" }, searchGroup, newBtn),
    avatars, rows,
    account,
  );

  // Main pane: the buddy peeking over the input pill, then the greeting and the hold-to-talk hint.
  const closeBtn = h("button", { class: "home-close", type: "button", title: "Minimize", "aria-label": "Minimize pill", onclick: () => actions.collapse() }, svg(ICONS.xmark, 13));
  const hello = h("div", { class: "home-hello" });
  const summary = h("div", { class: "home-summary", text: HOLD_HINT });
  const hero = h("div", { class: "home-hero", "aria-hidden": "true" }, buddy(PROVIDER_COLORS.codex, 138, { hero: true, seed: "m9r" }));
  const inputPill = h("button", { class: "home-input-pill", type: "button", onclick: () => { actions.blip(); actions.setView("prompt"); } },
    svg(ICONS.mic, 13), h("span", { text: "Hi, how can I help ^_^?" }));
  const idle = h("div", { class: "home-idle" }, h("div", { class: "home-stage" }, hero, inputPill), hello, summary);

  // Main pane: the selected agent's activity.
  const dName = h("span", { class: "home-d-name" });
  const dDot = h("span", { class: "home-d-dot" });
  const dStatus = h("span", { class: "home-d-status" });
  const dActions = h("div", { class: "home-d-actions" });
  const dTask = h("div", { class: "home-d-task" });
  const dFeed = h("div", { class: "home-d-feed" });
  const detail = h("div", { class: "home-detail" },
    h("div", { class: "home-d-head" }, dDot, dName, dStatus, h("div", { class: "grow" }), dActions),
    dTask,
    dFeed,
  );
  // One interface: the rail + Chats panel is the only nav now, so the old second sidebar is not
  // mounted. Its agent faces move into the main pane as a status strip; picking one shows its feed.
  void side; void closeBtn;
  const main = h("section", { class: "home-main" }, avatars, idle, detail);
  const el = h("div", { class: "view overview home home-single" }, main);

  let selectedId: string | null = null;
  // When the pill last saw each agent's preview change: the thread carries no timestamps, so this is observation time.
  const seen = new Map<string, { text: string; at: number }>();
  let rowsKey = "";
  let detailKey = "";

  function lastSeen(task: AgentTask, text: string): number {
    const prev = seen.get(task.id);
    if (prev && prev.text === text) return prev.at;
    const at = Date.now();
    seen.set(task.id, { text, at });
    return at;
  }

  function select(id: string | null) {
    selectedId = id;
    if (id) actions.setFocus(id);
    else { rowsKey = ""; detailKey = ""; sync(); }
  }

  function renderSidebar() {
    const needle = search.value.trim().toLowerCase();
    const items = State.tasks.map((task) => {
      const preview = agentPreview(task);
      return { task, preview, at: lastSeen(task, preview), pending: State.approvals.filter((a) => a.agent === task.id).length };
    });
    items.sort((a, b) => (a.task.state === "approval" ? -1 : 0) - (b.task.state === "approval" ? -1 : 0)
      || b.at - a.at || (HOME_RANK[a.task.runState] ?? 6) - (HOME_RANK[b.task.runState] ?? 6));
    const shown = needle
      ? items.filter((i) => `${displayName(i.task)} ${i.task.name} ${i.preview}`.toLowerCase().includes(needle))
      : items;
    const conn = State.brokerConnection;
    const firstApproval = State.approvals[0];
    const key = JSON.stringify([selectedId, needle, items.map((i) => [i.task.id, i.task.color, i.task.state, i.preview, shortTime(i.at), i.pending]),
      conn, State.approvals.length, firstApproval?.id]);
    if (key === rowsKey) return;
    rowsKey = key;

    avatars.replaceChildren(...items.map(({ task }) => {
      const b = h("button", {
        class: "home-avatar" + (task.id === selectedId ? " on" : ""), type: "button",
        title: `${displayName(task)} · ${plainStatus(task).label}`, "aria-label": displayName(task),
        onclick: () => select(task.id === selectedId ? null : task.id),
      }, h("span", { class: "home-avatar-circle", style: `--tint:${task.color}` }, buddy(task.color, 40, { seed: task.id })),
        h("span", { class: "home-avatar-label", text: displayName(task) }));
      b.classList.toggle("live", plainStatus(task).live);
      return b;
    }));
    avatars.hidden = items.length === 0;

    // Pinned first row, HeyClicky's "Suggestions" slot: what is waiting on the owner, with its count.
    const waiting = State.approvals.length;
    const requests = needle ? null : h("button", {
      class: "home-row home-row-requests", type: "button", role: "option", "aria-selected": "false",
      "aria-label": waiting ? `Requests: ${waiting} waiting on you` : "Requests: nothing waiting",
      // Approvals are folded into the one main chat as inline cards, not a separate screen.
      onclick: () => { if (!waiting) return; actions.blip(); actions.setView("prompt"); },
    },
      h("span", { class: "home-row-thumb home-row-spark" }, svg(ICONS.star, 13)),
      h("span", { class: "home-row-body" },
        h("span", { class: "home-row-head" },
          h("span", { class: "home-row-name", text: "Requests" }),
          waiting ? h("span", { class: "home-row-badge", text: String(waiting) }) : null,
          h("span", { class: "home-row-time", text: waiting ? "now" : "" }),
        ),
        h("span", { class: "home-row-preview", text: firstApproval
          ? approvalSentence(displayName(State.tasks.find((t) => t.id === firstApproval.agent) ?? { provider: "agent", name: firstApproval.agent }), firstApproval.title)
          : "Nothing needs you right now." }),
      ),
    );

    const agentRows = shown.map(({ task, preview, at, pending }) => {
      const on = task.id === selectedId;
      return h("button", {
        class: "home-row" + (on ? " on" : ""), type: "button", role: "option", "aria-selected": on ? "true" : "false",
        "aria-label": `${displayName(task)}: ${preview}`,
        onclick: () => select(on ? null : task.id),
      },
        h("span", { class: "home-row-thumb", style: `--tint:${task.color}` }, buddy(task.color, 30, { seed: task.id })),
        h("span", { class: "home-row-body" },
          h("span", { class: "home-row-head" },
            h("span", { class: "home-row-name", text: displayName(task) }),
            pending ? h("span", { class: "home-row-badge", text: String(pending), title: `${pending} waiting on you` }) : null,
            h("span", { class: "home-row-time", text: shortTime(at) }),
          ),
          h("span", { class: "home-row-preview", text: preview }),
        ),
      );
    });
    const empty = shown.length ? null : h("div", { class: "mp-empty" }, items.length
      ? h("div", { class: "mp-empty-title", text: "No matches" })
      : h("div", { class: "mp-empty-title", text: "No agents yet" }), items.length ? "Try a different name." : "Connected agents show up here.");
    rows.replaceChildren(...([requests, ...agentRows, empty] as (HTMLElement | null)[]).filter((x): x is HTMLElement => !!x));

    acctStatus.replaceChildren(h("span", { text: CONNECTION_LABEL[conn] }), h("i", { class: "home-acct-ring" }));
    acctStatus.dataset.state = conn;
  }

  function renderDetail() {
    const task = selectedId ? State.tasks.find((t) => t.id === selectedId) ?? null : null;
    idle.hidden = !!task;
    detail.hidden = !task;
    if (!task) {
      hello.textContent = greeting();
      summary.textContent = State.tasks.length ? HOLD_HINT : teamSummary();
      summary.title = teamSummary();
      detailKey = "";
      return;
    }
    const status = plainStatus(task);
    const steps = task.steps.map((s) => plainStep(task, s)).filter((s, i, all) => s && all.indexOf(s) === i);
    const messages = agentMessages(task);
    const pending = State.approvals.filter((a) => a.agent === task.id);
    const key = JSON.stringify([task.id, task.color, task.task, status, steps, messages.map((m) => [m.id, m.role, m.content]), pending.map((a) => a.id)]);
    if (key === detailKey) return;
    detailKey = key;

    dDot.replaceChildren(dot(task.color, 9));
    dName.textContent = displayName(task);
    dStatus.textContent = status.label;
    dStatus.style.setProperty("--tone", status.color);
    dStatus.classList.toggle("live", status.live);
    dTask.textContent = task.task ? plainStep(task, task.task) : "";
    dTask.hidden = !task.task;

    dActions.replaceChildren(...[
      pending.length ? btn("Review", "primary", () => { actions.setFocus(task.id); actions.setView("prompt"); }) : null,
      btn("Message", pending.length ? "secondary" : "primary", () => {
        actions.setFocus(task.id);
        State.composeTo = [task.id];
        actions.setView("prompt");
      }),
    ].filter((x): x is HTMLElement => !!x));

    const feed: HTMLElement[] = [];
    feed.push(h("div", { class: "home-d-kicker", text: "Activity" }));
    if (steps.length) {
      feed.push(h("ol", { class: "home-d-steps" }, ...steps.slice(-8).map((s, i, all) =>
        h("li", { class: "home-d-step" + (i === all.length - 1 ? " now" : ""), text: s }))));
    } else {
      feed.push(h("div", { class: "home-d-empty", text: plainStep(task, "") }));
    }
    if (messages.length) {
      feed.push(h("div", { class: "home-d-kicker", text: "Messages" }));
      for (const m of messages.slice(-6)) {
        const mine = m.role === "user";
        feed.push(h("div", { class: "home-d-msg" + (mine ? " mine" : "") },
          h("span", { class: "home-d-from", text: mine ? "You" : displayName(State.tasks.find((t) => t.name === m.from) ?? { provider: "agent", name: m.from ?? task.name }) }),
          h("span", { class: "home-d-text", text: messageText(m) }),
        ));
      }
    }
    dFeed.replaceChildren(...feed);
    dFeed.scrollTop = dFeed.scrollHeight;
  }

  function sync() {
    if (selectedId && !State.tasks.some((t) => t.id === selectedId)) selectedId = null;
    renderSidebar();
    renderDetail();
  }

  search.addEventListener("input", () => { rowsKey = ""; renderSidebar(); });
  search.addEventListener("pointerdown", () => actions.focusWindow?.(true));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = ""; rowsKey = ""; renderSidebar(); }
  });

  return {
    el,
    sync,
    activate() {
      // Home always opens on the greeting; picking an agent is the owner's move.
      selectedId = null;
      search.value = "";
      rowsKey = "";
      detailKey = "";
    },
    deactivate() {
      if (document.activeElement === search) { search.blur(); actions.focusWindow?.(false); }
    },
  };
}

// ── Empty ────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h("div", { class: "title", text: "No active agent work yet." }),
    h("div", { class: "grow" }),
    btn("Send a message", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Error ────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Agent task stopped with an error." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" }, btn("OK", "secondary", () => actions.collapse()));
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, "stopped"));
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ─────────────────────────────────────────────────────

/** The handback leads with the task and keeps recent activity available on demand. */
function buildFinished(actions: ViewActions): ViewHost {
  const name = h("span", { class: "ask-name" });
  const headline = h("div", { class: "ask-sentence" });
  const band = h("div", { class: "done-band" },
    h("div", { class: "ask-text" },
      h("div", { class: "ask-head" }, name, h("span", { class: "drum-tag done-tag", text: "Done" })),
      headline,
    ),
  );
  const steps = h("ol", { class: "done-steps" });
  const activity = h("details", { class: "done-activity" }, h("summary", { text: "Recent activity" }), steps);
  const foot = h("div", { class: "done-foot" },
    btn("Reply", "secondary", () => actions.setView("prompt")),
    btn("Close", "primary", () => actions.collapse()),
  );
  const el = h("div", { class: "view finished-view" }, band, activity, foot);
  let key = "";
  return {
    el,
    activate() {
      State.stateOverride = "finished";
      key = "";
      activity.open = false;
    },
    deactivate() {
      State.stateOverride = null;
    },
    sync() {
      const task = State.focusTask;
      if (!task) return;
      const done = task.steps.map((s) => plainStep(task, s)).filter((s, i, all) => s && all.indexOf(s) === i);
      const title = task.task ? plainStep(task, task.task) : done.at(-1) ?? "Finished what you asked.";
      const trail = done.filter((s) => s !== title).slice(-3);
      const next = `${task.id}|${title}|${trail.join("|")}`;
      if (next === key) return;
      key = next;
      name.textContent = displayName(task);
      headline.textContent = title;
      steps.replaceChildren(...trail.map((text) => h("li", { class: "done-step", text })));
      activity.hidden = trail.length === 0;
    },
  };
}

// ── Drop ─────────────────────────────────────────────────────────

/** A file is being dragged over the pill: every connected provider is a target, the one under the cursor lights up. */
function buildDrop(): ViewHost {
  const caption = h("div", { class: "drop-caption" });
  const sub = h("div", { class: "drop-sub", text: "Then tell it what to do." });
  const row = h("div", { class: "drop-agents" });
  const frame = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  frame.setAttribute("class", "drop-frame");
  frame.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x: "1", y: "1", rx: "20", ry: "20", fill: "none", "stroke-width": "1.5", "stroke-dasharray": "6 5" })) rect.setAttribute(k, v);
  rect.style.width = "calc(100% - 2px)";
  rect.style.height = "calc(100% - 2px)";
  frame.append(rect);
  const zone = h("div", { class: "drop-zone" }, frame, h("div", { class: "drop-copy" }, caption, sub), row);
  const el = h("div", { class: "view drop-view" }, zone);
  let key = "";
  return {
    el,
    sync() {
      const next = State.tasks.map((t) => `${t.id}:${t.state}`).join("|");
      if (next !== key) {
        key = next;
        row.replaceChildren(...State.tasks.map((task) => {
          const tile = h("div", { class: "drop-agent", "data-agent": task.id },
            h("span", { class: "drop-mark" }, providerLogo(task.provider, 20)),
            h("span", { class: "drop-name", text: displayName(task) }),
          );
          tile.style.setProperty("--tone", botGlowColor(task.state === "idle" || task.state === "sleeping" ? "working" : task.state));
          return tile;
        }));
      }
      const p = State.dragPoint;
      const hit = p ? (document.elementFromPoint(p.x, p.y)?.closest("[data-agent]") as HTMLElement | null)?.dataset.agent : undefined;
      const target = State.tasks.find((t) => t.id === hit) ?? State.focusTask;
      for (const tile of row.children as HTMLCollectionOf<HTMLElement>) {
        tile.classList.toggle("hot", tile.dataset.agent === hit);
        tile.classList.toggle("implied", !hit && tile.dataset.agent === target?.id);
      }
      zone.classList.toggle("aimed", !!hit);
      caption.textContent = target ? `Drop to hand it to ${displayName(target)}` : "Drop it here";
    },
  };
}

// ── Note ─────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── Settings ─────────────────────────────────────────────────────

/** One Settings card: the plain setting name, then its control. */
function settingsCard(title: string, control: HTMLElement): HTMLElement {
  return h("div", { class: "settings-card" }, h("div", { class: "settings-card-title", text: title }), control);
}

/** Settings, Muse's own way: a modal over whatever chat is open, not a page that replaces it. */
export function buildSettings(actions: ViewActions, onClose: () => void): ViewHost {
  const ONOFF = ["Off", "On"];
  const sound = dotSlider(ONOFF, "Sound", (i) => { if (State.settings.soundEnabled !== (i === 1)) actions.toggleSound(); });
  const voice = dotSlider(ONOFF, "Spoken updates", (i) => actions.updateSettings({ voiceEnabled: i === 1 }));
  const RATES = [{ label: "Slower", rate: 0.85 }, { label: "Normal", rate: 1 }, { label: "Faster", rate: 1.2 }];
  const rate = dotSlider(RATES.map((r) => r.label), "Speed", (i) => actions.updateSettings({ voiceRate: RATES[i].rate }));
  const CLOSES = [10, 15, 30];
  const autoClose = dotSlider(CLOSES.map((s) => `${s}s`), "Auto-close", (i) => actions.setAutoClose(CLOSES[i]));
  const GLOWS = [{ label: "Status", style: "status" }, { label: "Rainbow", style: "rainbow" }, { label: "Off", style: "off" }] as const;
  const glow = dotSlider(GLOWS.map((g) => g.label), "Edge glow", (i) => actions.updateSettings({ glowStyle: GLOWS[i].style }));

  const glowColorInput = h("input", { class: "glow-color-input", type: "color", tabindex: -1, "aria-hidden": true }) as HTMLInputElement;
  glowColorInput.addEventListener("change", () => actions.updateSettings({ glowColor: glowColorInput.value }));
  const glowColorButton = h("button", { class: "settings-swatch", type: "button", title: "Choose a custom edge-glow color",
    "aria-label": "Choose a custom edge-glow color", onclick: () => glowColorInput.click() });
  const glowColorReset = h("button", { class: "settings-btn", type: "button", text: "Auto", title: "Use the current status colors again",
    onclick: () => actions.updateSettings({ glowColor: null }) });

  // Muse's Settings layout: a category list on the left, the active category's cards on the right.
  // "Sound and voice" is hidden for now: core/sound.ts is a no-op, so its Sound toggle did nothing.
  // The controls stay built (and synced) so the category returns by re-adding this one line:
  //   { id: "sound", label: "Sound and voice", icon: ICONS.railSoundOn, cards: [settingsCard("Sound", sound.el), settingsCard("Spoken updates", voice.el), settingsCard("Speed", rate.el)] },
  const CATEGORIES: { id: string; label: string; icon: string; cards: HTMLElement[] }[] = [
    { id: "general", label: "General", icon: ICONS.gear, cards: [settingsCard("Auto-close", autoClose.el)] },
    { id: "appearance", label: "Appearance", icon: ICONS.display, cards: [
      settingsCard("Edge glow", glow.el),
      settingsCard("Custom color", h("div", { class: "settings-color" }, glowColorButton, glowColorReset, glowColorInput))] },
  ];
  let activeCat = "general";
  const paneTitle = h("div", { class: "set-pane-title" });
  const paneBody = h("div", { class: "set-pane-body" });
  const catButtons = CATEGORIES.map((c) => {
    const icon = c.icon.startsWith("M4 9.5") ? svg(c.icon, 15, { stroke: 1.7 }) : svg(c.icon, 15);
    const b = h("button", { class: "set-cat", type: "button", onclick: () => { actions.blip(); showCat(c.id); } }, icon, h("span", { text: c.label }));
    b.dataset.cat = c.id;
    return b;
  });
  function showCat(id: string) {
    activeCat = id;
    const c = CATEGORIES.find((x) => x.id === id) ?? CATEGORIES[0];
    paneTitle.textContent = c.label;
    paneBody.replaceChildren(...c.cards);
    for (const b of catButtons) b.classList.toggle("on", b.dataset.cat === activeCat);
  }
  showCat(activeCat);
  void buildSettingsDrum;

  const closeBtn = h("button", { class: "settings-close", type: "button", title: "Close Settings", "aria-label": "Close Settings", onclick: () => { actions.blip(); onClose(); } }, svg(ICONS.xmark, 13));
  const el = h("div", { class: "settings-page" },
    h("aside", { class: "set-side" }, h("div", { class: "set-side-title", text: "Settings" }), ...catButtons),
    h("section", { class: "set-pane" }, h("div", { class: "set-pane-head" }, paneTitle, closeBtn), paneBody));

  /** Index of the stop nearest `value`, so an off-list saved value still lands on a stop. */
  const nearest = (list: readonly number[], value: number) =>
    list.reduce((best, v, i) => (Math.abs(v - value) < Math.abs(list[best] - value) ? i : best), 0);

  return {
    el,
    sync() {
      const s = State.settings;
      sound.sync(s.soundEnabled ? 1 : 0);
      voice.sync(s.voiceEnabled ? 1 : 0);
      rate.sync(nearest(RATES.map((r) => r.rate), s.voiceRate));
      autoClose.sync(nearest(CLOSES, s.autoCloseInterval));
      glow.sync(Math.max(0, GLOWS.findIndex((g) => g.style === s.glowStyle)));
      glowColorButton.style.setProperty("--glow-picked", s.glowColor ?? "transparent");
      glowColorButton.classList.toggle("custom", s.glowColor !== null);
      glowColorReset.hidden = s.glowColor === null;
      glowColorInput.value = s.glowColor ?? "#FFFFFF";
    },
  };
}

// ── Model/effort helpers ─────────────────────────────────────────
// Shared by the composer's model chip (./model-chip.ts); the owner's full model-picker
// page was retired once the chip could show and change the focused agent's model/effort
// on its own -- a dedicated page for that one job was redundant with it.

export type PickerProvider = "claude" | "codex" | "opencode" | "agent";

export function pickerProvider(provider: string): PickerProvider {
  const value = provider.toLowerCase();
  if (value.startsWith("claude")) return "claude";
  if (value.startsWith("codex")) return "codex";
  if (value.startsWith("opencode")) return "opencode";
  return "agent";
}

export const PROVIDER_NAMES: Record<PickerProvider, string> = { claude: "Anthropic", codex: "OpenAI", opencode: "OpenCode", agent: "Agent" };

/** Providers report effort ids like "low" or "xhigh" as labels; show them as words. */
export function effortLabel(label: string): string {
  if (label.toLowerCase() === "xhigh") return "Extra high";
  return label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

// ── Registry ─────────────────────────────────────────────────────

export function buildViews(actions: ViewActions, onChatHeightChange: () => void): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("drop", buildDrop());
  map.set("note", buildNote());
  map.set("prompt", buildPrompt(actions, onChatHeightChange));
  // Identity is not a view any more: it is Muse's right-hand avatar panel, built by the island
  // (see buildIdentity in ./identity) and shown beside whatever view is open.
  return map;
}
