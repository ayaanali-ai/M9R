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
    get animating() {
      return ticker.animating;
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
      const key = `${overflow}|${others.map((t) => `${t.id}:${t.state}:${t.pillBadge ?? ""}`).join("|")}`;
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
// Modeled on the owner's ModelSelectorPrompt: a searchable list with provider
// labels and configuration badges, and a preview panel with the Reasoning
// configuration. Only provider-reported data is shown; nothing is invented.

type PickerProvider = "claude" | "codex" | "opencode" | "agent";

function pickerProvider(provider: string): PickerProvider {
  const value = provider.toLowerCase();
  if (value.startsWith("claude")) return "claude";
  if (value.startsWith("codex")) return "codex";
  if (value.startsWith("opencode")) return "opencode";
  return "agent";
}

const PROVIDER_NAMES: Record<PickerProvider, string> = { claude: "Anthropic", codex: "OpenAI", opencode: "OpenCode", agent: "Agent" };

/** Providers report effort ids like "low" or "xhigh" as labels; show them as words. */
function effortLabel(label: string): string {
  if (label.toLowerCase() === "xhigh") return "Extra high";
  return label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

export function buildModelPicker(actions: ViewActions): ViewHost {
  const tabs = h("div", { class: "mp-agents", role: "tablist", "aria-label": "Agent" });
  const search = h("input", { class: "mp-search-input", type: "text", placeholder: "Search models...", "aria-label": "Search models" }) as HTMLInputElement;
  const searchGroup = h("label", { class: "mp-search" }, search, svg(ICONS.search, 12, { stroke: 2 }));
  const rows = h("div", { class: "mp-rows", role: "listbox", "aria-label": "Models" });
  const fade = h("div", { class: "mp-fade", "aria-hidden": "true" });
  const listWrap = h("div", { class: "mp-list" }, rows, fade);
  const left = h("div", { class: "mp-left" }, tabs, searchGroup, listWrap);
  const preview = h("div", { class: "mp-preview", "aria-live": "polite" });
  const body = h("div", { class: "mp-body" }, left, preview);
  const el = h("div", { class: "view model-picker-view" }, card(null, body));

  let key = "";
  let activeHandle = "";
  let previewId = "";
  let pending: { handle: string; model: string; effort: string | null; applying: boolean } | null = null;
  let failure: { handle: string; text: string } | null = null;

  const agents = (): PillModelAgent[] => State.models?.agents ?? [];
  const activeAgent = (): PillModelAgent | undefined => agents().find((agent) => agent.handle === activeHandle);
  const effectiveModel = (agent: PillModelAgent): string =>
    (pending?.handle === agent.handle ? pending.model : null) ?? agent.selectedModel ?? agent.currentModel ?? "";
  const effectiveEffort = (agent: PillModelAgent): string =>
    (pending?.handle === agent.handle ? pending.effort : null) ?? agent.selectedEffort ?? agent.currentEffort ?? "";

  function updateFade() {
    fade.classList.toggle("on", rows.scrollHeight - rows.scrollTop - rows.clientHeight > 4);
  }
  rows.addEventListener("scroll", updateFade, { passive: true });

  async function pick(agent: PillModelAgent, model: string, effort: string | null) {
    if (!actions.selectModel) return;
    const request = { handle: agent.handle, model, effort, applying: true };
    pending = request;
    failure = null;
    renderRows();
    renderPreview();
    try {
      await actions.selectModel(agent.handle, model || null, effort);
      if (pending !== request) return;
      request.applying = false;
      renderRows();
      // Keep the choice shown until the provider's own state confirms it, but never indefinitely.
      setTimeout(() => { if (pending === request) { pending = null; key = ""; sync(); } }, 10_000);
    } catch {
      if (pending !== request) return;
      pending = null;
      failure = { handle: agent.handle, text: `Could not change @${agent.handle}; the previous model is still active.` };
      renderRows();
      renderPreview();
    }
  }

  function badge(agent: PillModelAgent, modelId: string): HTMLElement | null {
    if (modelId !== effectiveModel(agent)) return null;
    const effortId = effectiveEffort(agent);
    const label = agent.models.find((model) => model.id === modelId)?.efforts?.find((effort) => effort.id === effortId)?.label;
    return label ? h("span", { class: "mp-badge" }, svg(ICONS.brain, 10), effortLabel(label)) : null;
  }

  function renderTabs() {
    tabs.replaceChildren();
    for (const agent of agents()) {
      const on = agent.handle === activeHandle;
      tabs.append(h("button", {
        class: "mp-agent" + (on ? " on" : ""), role: "tab", "aria-selected": on ? "true" : "false",
        onclick: () => {
          if (activeHandle === agent.handle) return;
          activeHandle = agent.handle;
          previewId = "";
          search.value = "";
          renderAll();
        },
      }, providerLogo(pickerProvider(agent.provider), 13), h("span", { text: "@" + agent.handle })));
    }
  }

  function renderRows() {
    rows.replaceChildren();
    const agent = activeAgent();
    searchGroup.hidden = !agent || agent.availability !== "available" || agent.models.length === 0;
    if (!agent) {
      rows.append(h("div", { class: "mp-empty", text: "No connected agents yet." }));
      updateFade();
      return;
    }
    if (agent.availability === "not_connected") {
      rows.append(h("div", { class: "mp-empty", text: `@${agent.handle} is not connected.` }));
      updateFade();
      return;
    }
    if (agent.availability !== "available" || agent.models.length === 0) {
      rows.append(h("div", { class: "mp-empty", text: `@${agent.handle} has not reported a live model catalog yet.` }));
      updateFade();
      return;
    }
    const needle = search.value.trim().toLowerCase();
    const options = needle
      ? agent.models.filter((model) => model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
      : agent.models;
    if (!options.length) {
      rows.append(h("div", { class: "mp-empty" }, h("div", { class: "mp-empty-title", text: "No models found" }), "Maybe try a different search."));
      updateFade();
      return;
    }
    const providerName = PROVIDER_NAMES[pickerProvider(agent.provider)];
    const current = effectiveModel(agent);
    for (const model of options) {
      const on = model.id === current;
      const applying = pending?.handle === agent.handle && pending.model === model.id && pending.applying;
      const row = h("button", {
        class: "mp-row" + (on ? " on" : "") + (model.id === previewId ? " preview" : ""),
        role: "option", "aria-selected": on ? "true" : "false",
        onclick: () => { if (model.id !== current) void pick(agent, model.id, null); },
        onmouseenter: () => { previewId = model.id; renderPreview(); markPreview(); },
        onfocus: () => { previewId = model.id; renderPreview(); markPreview(); },
      },
        h("span", { class: "mp-row-text" },
          h("span", { class: "mp-row-label", text: model.label }),
          h("span", { class: "mp-row-provider" }, providerLogo(pickerProvider(agent.provider), 10), providerName)),
        badge(agent, model.id),
        applying ? h("span", { class: "mp-spin", "aria-label": "Applying" }) : on ? svg(ICONS.check, 12) : null,
      );
      row.dataset.id = model.id;
      rows.append(row);
    }
    requestAnimationFrame(updateFade);
  }

  function markPreview() {
    for (const row of rows.querySelectorAll<HTMLElement>(".mp-row")) row.classList.toggle("preview", row.dataset.id === previewId);
  }

  function renderPreview() {
    preview.replaceChildren();
    const agent = activeAgent();
    if (!agent || agent.availability !== "available" || !agent.models.length) {
      preview.hidden = true;
      return;
    }
    preview.hidden = false;
    const model = agent.models.find((option) => option.id === (previewId || effectiveModel(agent))) ?? agent.models[0];
    const provider = pickerProvider(agent.provider);
    const isCurrent = model.id === effectiveModel(agent);
    const head = h("div", { class: "mp-p-head" },
      h("div", { class: "mp-p-title", text: model.label }),
      h("div", { class: "mp-p-provider" }, providerLogo(provider, 11), PROVIDER_NAMES[provider], isCurrent ? h("span", { class: "mp-p-current", text: "In use" }) : null),
      model.description ? h("p", { class: "mp-p-desc", text: model.description }) : null,
    );
    const config = h("div", { class: "mp-p-config" }, h("div", { class: "mp-p-kicker", text: "Configuration" }));
    if (model.efforts?.length) {
      const chosen = isCurrent ? effectiveEffort(agent) : "";
      const group = h("div", { class: "mp-radio", role: "radiogroup", "aria-label": "Reasoning level" });
      for (const effort of model.efforts) {
        const on = effort.id === chosen;
        group.append(h("button", {
          class: "mp-radio-item" + (on ? " on" : ""), role: "radio", "aria-checked": on ? "true" : "false",
          onclick: () => void pick(agent, model.id, effort.id),
        }, effortLabel(effort.label)));
      }
      config.append(h("div", { class: "mp-p-label", text: "Reasoning" }), group);
    } else {
      config.append(h("div", { class: "mp-p-none", text: "This model has no reasoning levels to configure." }));
    }
    preview.append(head, config);
    if (failure?.handle === agent.handle) preview.append(h("div", { class: "mp-p-error", role: "alert", text: failure.text }));
  }

  function renderAll() {
    const list = agents();
    if (!list.some((agent) => agent.handle === activeHandle)) {
      activeHandle = (list.find((agent) => agent.availability === "available" && agent.models.length) ?? list[0])?.handle ?? "";
    }
    renderTabs();
    renderRows();
    renderPreview();
    requestAnimationFrame(() => {
      rows.querySelector<HTMLElement>(".mp-row.on")?.scrollIntoView({ block: "nearest" });
      updateFade();
    });
  }

  search.addEventListener("input", renderRows);

  function sync() {
    const list = agents();
    // A confirmed selection from the provider replaces the optimistic one.
    if (pending && !pending.applying) {
      const agent = list.find((item) => item.handle === pending!.handle);
      if (agent && (agent.selectedModel ?? agent.currentModel) === pending.model
        && (!pending.effort || (agent.selectedEffort ?? agent.currentEffort) === pending.effort)) pending = null;
    }
    const nextKey = JSON.stringify([pending, list.map((agent) => [agent.handle, agent.provider, agent.availability, agent.currentModel, agent.currentEffort,
      agent.selectedModel, agent.selectedEffort, agent.models])]);
    if (nextKey === key && rows.childElementCount > 0) return;
    key = nextKey;
    renderAll();
  }

  sync();
  return { el, sync, activate() {
    const focused = State.focusTask?.name;
    if (focused && agents().some((agent) => agent.handle === focused)) activeHandle = focused;
    previewId = "";
    search.value = "";
    key = "";
    sync();
  } };
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
