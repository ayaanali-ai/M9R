// Island views: overview (focused agent's activity plus the others), approval, error, finished, message composer, settings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { providerLogo } from "./provider";
import { buildPrompt } from "./composer";
import { State, type AgentTask, type LinkOffer } from "../core/state";
import type { SessionRow } from "../core/transport";
import type { SpeechEnv } from "../core/speech";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  decide(d: "allow" | "deny" | "allow_day"): void;
  send(text: string): Promise<string | void>;
  /** Present only when the host can save to shared memory (the in-page pill). */
  saveMemory?(text: string): Promise<void>;
  canAllowForADay(): boolean;
  /** Present only when the host has speech recognition (the page frame); hold the mic to talk. */
  dictation?: () => SpeechEnv;
  /** Present only when the host can link sessions (the desktop shell). */
  linking?: {
    list(handle: string): Promise<SessionRow[]>;
    link(offer: LinkOffer, toSession: string): Promise<void>;
  };
  toggleSound(): void;
  setAutoClose(seconds: number): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Push-to-talk from the keyboard (the message view only). */
  talk?(active: boolean): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
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
  const tabHome = h("button", { class: "tab", title: "Agents", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Message", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.sliders, 14, { stroke: 1.7 }));
  const soundBtn = h("button", { title: "Sound", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOff, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      gearBtn.classList.toggle("on", v === "settings");
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
    },
  };
}

// ── Overview ─────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" }, tickerBody);
  const left = card(null, leftBody);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillKey = "";

  return {
    el,
    tick(nowMs: number) {
      ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      clear(who);
      if (task) {
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: `@${task.name}` }),
          h("span", { class: "tool", text: task.provider }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", { class: "count", text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}` }));
        }
      }
      ticker.sync(task);

      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => `${t.id}:${t.state}:${t.pillBadge ?? ""}`).join("|");
      if (key !== pillKey) {
        pillKey = key;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    providerLogo(task.provider, 24, task.state),
    h("span", { class: "lbl", text: `@${task.name}` }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

// ── Empty ────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "No agents connected yet." }),
      h("div", { class: "sub", text: "Start Claude Code, Codex or OpenCode in an M9R room." }),
    ),
    h("div", { class: "grow" }),
    btn("Send a message", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ─────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let built = false;
  return {
    el,
    sync() {
      const req = State.pendingApproval;
      const agent = State.tasks.find((t) => t.id === req?.agent) ?? null;
      clear(who);
      const more = State.approvals.length > 1 ? ` · ${State.approvals.length - 1} more waiting` : "";
      who.append(agentWho(agent ?? State.focusTask, `wants to: ${req?.title ?? "act"}${more}`));
      // The line being authorised: the action, path or address, not just the name of the tool asking.
      code.textContent = req?.detail || "…";
      // Built once: rebuilding buttons between a mouse-down and a mouse-up would swallow the click.
      if (built) return;
      built = true;
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        actions.canAllowForADay() ? btn("Allow for a day", "secondary", () => actions.decide("allow_day")) : "",
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Error ────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Session stopped on an error." });
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

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" }, btn("OK", "secondary", () => actions.collapse()));
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Finished";
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

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) => h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`));

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" })),
    h("div", { class: "settings-row" }, svg(ICONS.timer, 12), autoLabel, h("div", { class: "seg" }, ...segButtons)),
  );

  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
    },
  };
}

// ── Registry ─────────────────────────────────────────────────────

export function buildViews(actions: ViewActions, onChatHeightChange: () => void): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(actions, onChatHeightChange));
  return map;
}
