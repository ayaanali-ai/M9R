// Island views: overview (focused agent's activity plus the others), approval, error, finished, message composer, settings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { providerLogo } from "./provider";
import { buildPrompt } from "./composer";
import { State, type AgentTask, type LinkOffer, type PillModelAgent } from "../core/state";
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
  setAutoClose(seconds: number): void;
  blip(): void;
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
  const tabModels = h("button", { class: "tab", title: "Models", onclick: () => go("models") }, svg(ICONS.layers, 13));
  const brokerStatus = h("span", { class: "broker-status", role: "status", "aria-live": "polite" });
  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.sliders, 14, { stroke: 1.7 }));
  const soundBtn = h("button", { title: "Sound", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOff, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabModels),
    h("div", { class: "header-actions" }, brokerStatus, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabModels.classList.toggle("on", v === "models");
      gearBtn.classList.toggle("on", v === "settings");
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

// ── Overview ─────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" }, tickerBody);
  const left = card(null, leftBody);
  const pills = h("div", { class: "pills" });
  const presenceSummary = h("div", { class: "presence-summary", role: "status", "aria-live": "polite" });
  const right = card(null, presenceSummary, pills);

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

      const featured = State.collaboration?.featuredAgentIds ?? [];
      const others = State.otherTasks
        .slice()
        .sort((a, b) => (featured.indexOf(a.id) < 0 ? 999 : featured.indexOf(a.id)) - (featured.indexOf(b.id) < 0 ? 999 : featured.indexOf(b.id)))
        .slice(0, 4);
      const overflow = State.collaboration?.overflowCount ?? Math.max(0, State.otherTasks.length - others.length);
      presenceSummary.textContent = State.collaboration?.headline ?? "";
      presenceSummary.hidden = !State.collaboration?.headline;
      const key = `${State.collaboration?.headline ?? ""}|${overflow}|${others.map((t) => `${t.id}:${t.state}:${t.pillBadge ?? ""}`).join("|")}`;
      if (key !== pillKey) {
        pillKey = key;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        if (overflow > 0) pills.append(h("span", { class: "presence-more", text: `+${overflow} more` }));
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
      h("div", { class: "title", text: "No active agent work yet." }),
      h("div", { class: "sub", text: "M9R manages your provider processes on this device. Their work appears here when they start acting." }),
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
  const status = h("div", { class: "detail approval-status", role: "status", "aria-live": "polite" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, status, row)));
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
      const decisionError = req && State.decisionError?.approvalId === req.id ? State.decisionError.message : null;
      status.textContent = decisionError
        ? `Decision not sent: ${decisionError}`
        : req?.unconfirmed
          ? "Approval status is unconfirmed. M9R will validate your choice before applying it."
          : "";
      status.dataset.state = decisionError ? "error" : req?.unconfirmed ? "unconfirmed" : "";
      status.hidden = !decisionError && !req?.unconfirmed;
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

// ── Models ───────────────────────────────────────────────────────

function buildModelPicker(actions: ViewActions): ViewHost {
  const list = h("div", { class: "model-picker-list" });
  const el = h("div", { class: "view model-picker-view" }, card(null, h("div", { class: "model-picker" }, list)));
  let key = "";

  function agentSection(agent: PillModelAgent): HTMLElement {
    const section = h("div", { class: "model-picker-agent" });
    const statusNote = h("div", { class: "model-picker-note" });
    section.append(
      h("div", { class: "model-picker-agent-head" },
        providerLogo(agent.provider as Parameters<typeof providerLogo>[0], 16),
        h("span", { class: "model-picker-agent-name", text: "@" + agent.handle }),
      ),
    );

    if (agent.availability === "not_connected") {
      section.append(h("div", { class: "model-picker-empty", text: "Not connected." }));
      return section;
    }
    if (agent.availability !== "available" || agent.models.length === 0 || !actions.selectModel) {
      section.append(h("div", { class: "model-picker-empty", text: "This provider has not reported a live model catalog." }));
      return section;
    }

    const search = h("input", { class: "model-picker-search", type: "text", placeholder: "Search models…", "aria-label": `Search models for @${agent.handle}` }) as HTMLInputElement;
    const rows = h("div", { class: "model-picker-rows" });
    const effortRow = h("div", { class: "model-picker-efforts" });
    const selectedId = agent.selectedModel ?? agent.currentModel ?? "";

    function renderEfforts() {
      effortRow.replaceChildren();
      const chosen = agent.models.find((option) => option.id === selectedId);
      if (!chosen?.efforts?.length) { effortRow.hidden = true; return; }
      effortRow.hidden = false;
      const currentEffort = agent.selectedEffort ?? agent.currentEffort ?? "";
      for (const choice of chosen.efforts) {
        effortRow.append(h("button", {
          class: "model-picker-chip" + (choice.id === currentEffort ? " on" : ""),
          onclick: () => void pick(selectedId, choice.id),
        }, choice.label));
      }
    }

    async function pick(modelId: string, effortId: string | null) {
      try {
        await actions.selectModel?.(agent.handle, modelId || null, effortId);
        statusNote.textContent = `Sent to M9R for @${agent.handle}. Applies now or on the next restart, depending on the provider.`;
      } catch {
        statusNote.textContent = `Could not change @${agent.handle}; the previous selection is still active.`;
      }
    }

    function renderRows(filter: string) {
      rows.replaceChildren();
      const needle = filter.trim().toLowerCase();
      const options = needle ? agent.models.filter((option) => option.label.toLowerCase().includes(needle)) : agent.models;
      if (options.length === 0) {
        rows.append(h("div", { class: "model-picker-empty", text: "No models match." }));
        return;
      }
      for (const option of options) {
        const on = option.id === selectedId;
        rows.append(h("button", {
          class: "model-picker-row" + (on ? " on" : ""),
          onclick: () => { void pick(option.id, on ? (agent.selectedEffort ?? agent.currentEffort ?? null) : null); },
        },
          h("span", { class: "model-picker-row-label", text: option.label }),
          on ? svg(ICONS.check, 13) : null,
        ));
      }
    }

    search.addEventListener("input", () => renderRows(search.value));
    renderRows("");
    renderEfforts();
    section.append(search, rows, effortRow, statusNote);
    return section;
  }

  function render() {
    const agents = State.models?.agents ?? [];
    const nextKey = JSON.stringify(agents.map((agent) => [agent.handle, agent.availability, agent.currentModel, agent.currentEffort, agent.selectedModel, agent.selectedEffort, agent.models]));
    if (nextKey === key && list.childElementCount > 0) return;
    key = nextKey;
    list.replaceChildren();
    if (!agents.length) {
      list.append(h("div", { class: "model-picker-empty", text: "No connected agents yet." }));
      return;
    }
    for (const agent of agents) list.append(agentSection(agent));
  }

  render();
  return { el, sync: render };
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
  map.set("models", buildModelPicker(actions));
  return map;
}
