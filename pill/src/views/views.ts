// Island views: overview (focused agent's activity plus the others), approval, error, finished, message composer, settings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { providerLogo } from "./provider";
import { buildPrompt } from "./composer";
import { State, type AgentTask, type LinkOffer, type PillModelAgent } from "../core/state";
import type { SessionRow } from "../core/transport";
import type { SpeechEnv } from "../core/speech";
import { washRGBA, botGlowColor, type IslandViewName, type Wash } from "../core/layout";
import { plainStep, displayName } from "../core/humanize";
import { buildDrum } from "./drum";

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
    h("div", { class: "tabs" }, tabHome, tabChat),
    h("div", { class: "header-actions" }, brokerStatus, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
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
  // Focus changes come from the wheel itself, so they skip the setFocus action's own blip; the detent tick is the sound.
  const drum = buildDrum(ticker.el, (id) => State.setFocus(id), () => actions.blip());
  const el = h("div", { class: "view overview" }, drum.el);

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
      ticker.sync(task ? { ...task, steps: task.steps.length ? task.steps.map((s) => plainStep(task, s)) : [plainStep(task, "")] } : null);
      drum.sync();
    },
  };
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

/** "Post to the page" → "Codex wants to post to the page." */
function approvalSentence(name: string, title: string | undefined): string {
  const t = (title ?? "").trim().replace(/[.!]+$/, "");
  if (!t) return `${name} needs your OK.`;
  return `${name} wants to ${t.charAt(0).toLowerCase()}${t.slice(1)}.`;
}

/** The drum's band, holding a decision: same mark, same place, so the wheel itself is what asks. */
function buildApproval(actions: ViewActions): ViewHost {
  const name = h("span", { class: "ask-name" });
  const count = h("span", { class: "ask-count" });
  const sentence = h("div", { class: "ask-sentence" });
  // The line being authorised: the action, path or address, never just the name of the tool asking.
  const exact = h("div", { class: "ask-exact" });
  const status = h("div", { class: "ask-status", role: "status", "aria-live": "polite" });
  const buttons = h("div", { class: "ask-buttons" });
  const later = h("div", { class: "ask-later" });
  const band = h("div", { class: "ask-band" },
    h("div", { class: "ask-text" },
      h("div", { class: "ask-head" }, name, h("span", { class: "drum-tag ask-tag", text: "Needs you" }), count),
      sentence,
      exact,
    ),
    h("div", { class: "ask-side" }, buttons, later, status),
  );
  const el = h("div", { class: "view approval-view" }, band);
  let built = false;
  let shownId = "";
  return {
    el,
    sync() {
      const req = State.pendingApproval;
      const agent = State.tasks.find((t) => t.id === req?.agent) ?? State.focusTask;
      const label = agent ? displayName(agent) : "An agent";
      name.textContent = label;
      count.textContent = State.approvals.length > 1 ? `1 of ${State.approvals.length}` : "";
      sentence.textContent = approvalSentence(label, req?.title);
      exact.textContent = req?.detail || "";
      exact.hidden = !req?.detail;
      const decisionError = req && State.decisionError?.approvalId === req.id ? State.decisionError.message : null;
      status.textContent = decisionError
        ? "That didn't go through. Try again."
        : req?.unconfirmed
          ? "M9R will double-check this before it runs."
          : "";
      status.title = decisionError ?? "";
      status.dataset.state = decisionError ? "error" : req?.unconfirmed ? "unconfirmed" : "";
      status.hidden = !decisionError && !req?.unconfirmed;
      // A new request replays the arrival so a queued second approval doesn't slip in unnoticed.
      if (req && req.id !== shownId) {
        shownId = req.id;
        band.classList.remove("arrive");
        void band.offsetWidth;
        band.classList.add("arrive");
      }
      // Built once: rebuilding buttons between a mouse-down and a mouse-up would swallow the click.
      if (built) return;
      built = true;
      buttons.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
      if (actions.canAllowForADay()) {
        later.append(h("button", { class: "link-btn ask-day", text: "Allow for a day", onclick: () => actions.decide("allow_day") }));
      }
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

/** The task card: the drum's band turns green and says what finished, then the island grows downward with how it got there. */
function buildFinished(actions: ViewActions): ViewHost {
  const name = h("span", { class: "ask-name" });
  const headline = h("div", { class: "ask-sentence" });
  const band = h("div", { class: "done-band" },
    h("div", { class: "ask-text" },
      h("div", { class: "ask-head" }, name, h("span", { class: "drum-tag done-tag", text: "Done" }), h("span", { class: "ask-count", text: "Just now" })),
      headline,
    ),
  );
  const steps = h("ol", { class: "done-steps" });
  const foot = h("div", { class: "done-foot" },
    btn("Reply", "secondary", () => actions.setView("prompt")),
    btn("Done", "primary", () => actions.collapse()),
  );
  const el = h("div", { class: "view finished-view" }, band, steps, foot);
  let key = "";
  return {
    el,
    activate() {
      State.stateOverride = "finished";
      key = "";
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
      steps.replaceChildren(...trail.map((text, i) => {
        const li = h("li", { class: "done-step" }, h("span", { class: "done-check" }, svg(ICONS.check, 9, { stroke: 2.4 })), h("span", { text }));
        li.style.animationDelay = `${180 + i * 70}ms`;
        return li;
      }));
      steps.hidden = trail.length === 0;
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
  map.set("drop", buildDrop());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(actions, onChatHeightChange));
  map.set("models", buildModelPicker(actions));
  return map;
}
