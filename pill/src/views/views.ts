// Island views: overview (focused agent's activity plus the others), approval, error, finished, message composer, settings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { providerLogo } from "./provider";
import { buildPrompt } from "./composer";
import { State, type AgentTask, type LinkOffer } from "../core/state";
import type { DesktopStage, DesktopStageTransport, SessionRow } from "../core/transport";
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
  desktopStages?: DesktopStageTransport;
  toggleSound(): void;
  setAutoClose(seconds: number): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active; used for a lazy local-state refresh. */
  activate?(): void;
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
  const tabStage = actions.desktopStages
    ? h("button", { class: "tab", title: "Desktop stage", onclick: () => go("stage") }, svg(ICONS.display, 14, { stroke: 1.7 }))
    : null;
  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.sliders, 14, { stroke: 1.7 }));
  const soundBtn = h("button", { title: "Sound", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOff, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabStage),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabStage?.classList.toggle("on", v === "stage");
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

// ── Desktop stage ────────────────────────────────────────────────

function buildDesktopStage(actions: ViewActions): ViewHost {
  const desktopStages = actions.desktopStages;
  const status = h("div", { class: "stage-message", "aria-live": "polite" });
  const rows = h("div", { class: "stage-list" });
  const selectedTitle = h("div", { class: "stage-selected-title" });
  const selectedState = h("span", { class: "stage-selected-state" });
  const stageAction = h("div", { class: "stage-selected-actions" });
  const screenOutline = h("div", { class: "stage-screen-outline" }, svg(ICONS.display, 28));
  const previewCanvas = h("div", { class: "stage-preview-canvas" });
  const previewImage = h("img", { class: "stage-preview-image", alt: "Local snapshot of the registered stage window", draggable: "false" }) as HTMLImageElement;
  const cursorDot = h("span", { class: "stage-cua-cursor", "aria-hidden": "true" }) as HTMLSpanElement;
  previewImage.hidden = true;
  cursorDot.hidden = true;
  previewCanvas.append(previewImage, cursorDot);
  const previewTitle = h("div", { class: "stage-preview-title" });
  const previewCopy = h("div", { class: "stage-preview-copy" });
  const preview = h("div", { class: "stage-preview" }, screenOutline, previewCanvas, previewTitle, previewCopy);
  const name = h("input", { class: "stage-name", type: "text", maxlength: 40, placeholder: "Stage name", "aria-label": "New stage name" });
  const create = h("button", { class: "btn primary", onclick: () => void createStage() }, h("span", { text: "Create" }));
  const refresh = h("button", { class: "stage-icon-button", title: "Refresh stages", "aria-label": "Refresh stages", onclick: () => void refreshStages() }, "↻");
  const controls = h("form", { class: "stage-create", onsubmit: (event: Event) => { event.preventDefault(); void createStage(); } }, name, create);
  controls.hidden = true;
  const add = h("button", { class: "stage-icon-button", title: "New stage", "aria-label": "New stage", onclick: () => {
    controls.hidden = !controls.hidden;
    add.setAttribute("aria-expanded", String(!controls.hidden));
    if (!controls.hidden) name.focus();
  } }, "+");
  const listWrap = h("div", { class: "stage-list-wrap" },
    h("div", { class: "stage-rail-heading" }, h("span", { text: "YOUR STAGES" }), h("div", { class: "stage-rail-tools" }, refresh, add)), rows, controls);
  const el = h("div", { class: "view stage-view" },
    card(null,
      listWrap,
      h("div", { class: "stage-workspace" },
        h("div", { class: "stage-heading" }, selectedTitle, selectedState),
        preview,
        h("div", { class: "stage-footer" }, h("span", { class: "stage-local-label", text: "On this computer" }), stageAction),
        status,
      ),
    ),
  );

  let stages: DesktopStage[] = [];
  let loaded = false;
  let busy = false;
  let message = "";
  let selectedName: string | null = null;
  let capturedStageName: string | null = null;
  let captured: { dataUrl: string; width: number; height: number } | null = null;
  let cursor: { x: number; y: number } | null = null;

  function positionCursorMarker() {
    if (!captured || !cursor || previewImage.hidden) { cursorDot.hidden = true; return; }
    const imageRect = previewImage.getBoundingClientRect();
    const canvasRect = previewCanvas.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0 || canvasRect.width <= 0 || canvasRect.height <= 0) { cursorDot.hidden = true; return; }
    cursorDot.hidden = false;
    cursorDot.style.left = `${imageRect.left - canvasRect.left + cursor.x / captured.width * imageRect.width}px`;
    cursorDot.style.top = `${imageRect.top - canvasRect.top + cursor.y / captured.height * imageRect.height}px`;
  }

  function render() {
    status.textContent = message;
    status.hidden = !message;
    create.disabled = busy || !name.value.trim() || !desktopStages;
    refresh.disabled = busy || !desktopStages;
    name.disabled = busy || !desktopStages;
    rows.replaceChildren();
    const selected = stages.find((stage) => stage.name === selectedName) ?? stages.find((stage) => stage.isCurrent) ?? stages[0];
    selectedName = selected?.name ?? null;
    selectedTitle.textContent = selected?.name ?? "Desktop stage";
    selectedState.textContent = selected ? (selected.status === "current" ? "You’re here" : selected.status === "background" ? "In background" : "Unavailable") : "";
    selectedState.dataset.state = selected?.status ?? "";
    const hasCapture = Boolean(selected && captured && capturedStageName === selected.name);
    screenOutline.hidden = hasCapture;
    previewCanvas.hidden = !hasCapture;
    previewTitle.textContent = !loaded ? "Loading your stages" : hasCapture ? "Local app-window snapshot" : selected ? "Desktop preview" : "A place for your agents";
    previewCopy.textContent = selected?.error ?? (hasCapture
      ? cursor ? "Local Cua cursor position confirmed. This snapshot stays on this PC." : "Local snapshot · stays on this PC. Click the image to place the Cua cursor."
      : selected?.hasAnchor ? "Capture a verified window from this stage." : selected ? "Register an app window on this stage to enable a local snapshot." : "Create a stage to keep agent windows together.");
    if (hasCapture && captured) {
      if (previewImage.src !== captured.dataUrl) previewImage.src = captured.dataUrl;
      previewImage.hidden = false;
      requestAnimationFrame(positionCursorMarker);
    } else {
      previewImage.hidden = true;
      cursorDot.hidden = true;
      if (previewImage.hasAttribute("src")) previewImage.removeAttribute("src");
    }
    stageAction.replaceChildren();
    if (selected && selected.status !== "unavailable") {
      if (selected.hasAnchor) stageAction.append(h("button", { class: "btn secondary", disabled: busy, onclick: () => void captureStage(selected.name) }, busy ? "Working…" : hasCapture ? "Refresh snapshot" : "Capture locally"));
      if (!selected.isCurrent) stageAction.append(h("button", { class: "btn primary", disabled: busy, onclick: () => void runStageAction("activate", selected.name) }, "Open desktop", svg(ICONS.display, 12)));
      else if (selected.returnToDesktopId) stageAction.append(h("button", { class: "btn secondary", disabled: busy, onclick: () => void runStageAction("return", selected.name) }, "Return to yours"));
    }
    if (!desktopStages) {
      rows.append(h("div", { class: "stage-empty", text: "Desktop stages are available in the Windows desktop pill." }));
      return;
    }
    if (!loaded) {
      rows.append(h("div", { class: "stage-empty", text: "Loading local stages…" }));
      return;
    }
    if (stages.length === 0) {
      rows.append(h("div", { class: "stage-empty", text: "No stages saved on this PC yet." }));
      return;
    }
    for (const stage of stages) {
      const label = stage.status === "current" ? "Current desktop" : stage.status === "background" ? "Background desktop" : "Unavailable";
      const row = h("button", { class: `stage-row${stage.name === selectedName ? " selected" : ""}`, "aria-pressed": stage.name === selectedName, onclick: () => { selectedName = stage.name; render(); } },
        svg(ICONS.display, 15),
        h("div", { class: "stage-row-main" },
          h("div", { class: "stage-row-name", text: stage.name }),
          h("div", { class: "stage-row-state", "data-state": stage.status, text: label }),
        ),
      );
      rows.append(row);
    }
  }

  async function refreshStages() {
    if (!desktopStages || busy) return;
    busy = true;
    message = "Refreshing stages…";
    render();
    try {
      stages = await desktopStages.list();
      loaded = true;
      message = "";
    } catch (error) {
      loaded = true;
      message = `Could not read stages: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      render();
    }
  }

  async function captureStage(stageName: string) {
    if (!desktopStages || busy) return;
    busy = true;
    message = `Capturing “${stageName}” locally…`;
    render();
    try {
      const result = await desktopStages.capture(stageName);
      captured = { dataUrl: result.dataUrl, width: result.width, height: result.height };
      capturedStageName = stageName;
      cursor = null;
      selectedName = stageName;
      message = "Local snapshot captured. It was not shared with the room.";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      render();
    }
  }

  async function moveStageCursor(event: MouseEvent) {
    const selected = stages.find((stage) => stage.name === selectedName);
    if (!desktopStages || busy || !selected?.hasAnchor || !captured || capturedStageName !== selected.name || event.target !== previewImage) return;
    const rect = previewImage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(captured.width - 1, Math.round((event.clientX - rect.left) / rect.width * captured.width)));
    const y = Math.max(0, Math.min(captured.height - 1, Math.round((event.clientY - rect.top) / rect.height * captured.height)));
    busy = true;
    message = "Moving the Cua cursor on this local window…";
    render();
    try {
      const result = await desktopStages.moveCursor(selected.name, x, y);
      captured = { dataUrl: result.capture.dataUrl, width: result.capture.width, height: result.capture.height };
      capturedStageName = selected.name;
      cursor = { x: result.cursor.x, y: result.cursor.y };
      message = `Cua confirmed local cursor at ${result.cursor.x}, ${result.cursor.y}.`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      render();
    }
  }

  async function createStage() {
    const stageName = name.value.trim();
    if (!desktopStages || !stageName || busy) return;
    busy = true;
    message = `Creating “${stageName}”…`;
    render();
    try {
      await desktopStages.create(stageName);
      selectedName = stageName;
      name.value = "";
      controls.hidden = true;
      add.setAttribute("aria-expanded", "false");
      message = `Stage “${stageName}” created in the background.`;
      stages = await desktopStages.list();
      loaded = true;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      render();
    }
  }

  async function runStageAction(action: "activate" | "return", stageName: string) {
    if (!desktopStages || busy) return;
    busy = true;
    message = action === "activate" ? `Opening “${stageName}”…` : `Returning from “${stageName}”…`;
    render();
    try {
      if (action === "activate") await desktopStages.activate(stageName);
      else await desktopStages.returnToOwner(stageName);
      message = action === "activate" ? `“${stageName}” is now the active desktop.` : `Returned from “${stageName}”.`;
      stages = await desktopStages.list();
      loaded = true;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      render();
    }
  }

  name.addEventListener("input", () => {
    create.disabled = busy || !name.value.trim() || !desktopStages;
  });
  previewImage.addEventListener("load", positionCursorMarker);
  preview.addEventListener("click", (event) => void moveStageCursor(event));
  window.addEventListener("resize", positionCursorMarker);
  render();
  return {
    el,
    activate() { if (!loaded && !busy) void refreshStages(); },
    sync() { positionCursorMarker(); },
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
  if (actions.desktopStages) map.set("stage", buildDesktopStage(actions));
  return map;
}
