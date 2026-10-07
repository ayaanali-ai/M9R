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
  const status = h("div", { class: "detail approval-status" });
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
      status.textContent = req?.unconfirmed
        ? "Approval status is unconfirmed. M9R will validate your choice before applying it."
        : "";
      status.hidden = !req?.unconfirmed;
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
  const rows = h("div", { class: "stage-list" });
  const status = h("div", { class: "stage-message", "aria-live": "polite" });
  const detailTitle = h("div", { class: "stage-detail-title" });
  const detailSession = h("div", { class: "stage-detail-session" });
  const detailStatus = h("div", { class: "stage-detail-status" });
  const activityLabel = h("div", { class: "stage-detail-label" });
  const activity = h("div", { class: "stage-detail-task" });
  const cursorNote = h("div", { class: "stage-detail-note", text: "Agent cursors are native Windows overlays. This view switches to a desktop; it does not stream video." });
  const detailAction = h("div", { class: "stage-detail-action" });
  const refresh = h("button", {
    class: "stage-icon-button",
    title: "Refresh agent desktops",
    "aria-label": "Refresh agent desktops",
    onclick: () => void refreshStages(),
  }, "↻");
  const listWrap = h("div", { class: "stage-list-wrap" },
    h("div", { class: "stage-rail-heading" },
      h("span", { text: "AGENT DESKTOPS" }),
      h("div", { class: "stage-rail-tools" }, refresh),
    ),
    rows,
  );
  const detail = h("div", { class: "stage-workspace" },
    h("div", { class: "stage-heading" }, svg(ICONS.display, 18), detailStatus),
    detailTitle,
    detailSession,
    h("div", { class: "stage-detail-activity" }, activityLabel, activity),
    cursorNote,
    detailAction,
    status,
  );
  const el = h("div", { class: "view stage-view" }, card(null, listWrap, detail));

  let stages: DesktopStage[] = [];
  let loaded = false;
  let busy = false;
  let message = "";
  let selectedName: string | null = null;
  let refreshTimer: number | null = null;

  function agentTask(handle: string): AgentTask | undefined {
    return State.tasks.find((task) => task.name.toLowerCase() === handle.toLowerCase());
  }

  function agentStateLabel(task: AgentTask | undefined): string {
    if (!task) return "Not connected";
    if (task.runState === "working") return "Working";
    if (task.runState === "starting") return "Starting";
    if (task.state === "approval") return "Waiting for approval";
    if (task.runState === "failed") return "Error";
    if (task.runState === "stopped") return "Stopped";
    if (task.runState === "not_connected") return "Not connected";
    if (task.runState === "seen") return "Seen recently · live status unavailable";
    if (task.runState === "unknown") return "Live status unavailable";
    if (task.runState === "idle") return "Idle";
    return "Waiting";
  }

  function currentTaskText(task: AgentTask | undefined): string {
    if (!task) return "No current task reported.";
    if (task.runState === "working" || task.runState === "starting") return task.task ?? (task.runState === "working" ? "Working on a turn" : "Starting a turn");
    if (task.state === "approval") return "Waiting for approval.";
    if (task.runState === "failed") return "The agent reported an error.";
    if (task.runState === "stopped") return "The agent is stopped.";
    if (task.runState === "not_connected") return "No session for this agent has been seen on this computer.";
    if (task.runState === "seen") return "Seen recently; M9R cannot confirm its current activity.";
    if (task.runState === "unknown") return "M9R cannot confirm this agent's current activity.";
    if (task.runState === "waiting") return "The agent is waiting.";
    return "No current task reported.";
  }

  function stageLabel(stage: DesktopStage): string {
    if (stage.status === "current") return "Your current desktop";
    if (stage.status === "background") return "Windows desktop · background";
    return "Unavailable";
  }

  function render() {
    status.textContent = message;
    status.hidden = !message;
    refresh.disabled = busy || !desktopStages;
    rows.replaceChildren();

    if (!desktopStages) {
      rows.append(h("div", { class: "stage-empty", text: "Agent desktops are available in the Windows desktop pill." }));
      detailTitle.textContent = "Windows agent desktops";
      detailSession.textContent = "";
      detailStatus.textContent = "";
      activityLabel.textContent = "";
      activity.textContent = "This computer does not expose the local Stage controls.";
      cursorNote.hidden = true;
      detailAction.replaceChildren();
      return;
    }
    if (!loaded) rows.append(h("div", { class: "stage-empty", text: "Loading agent desktops…" }));

    const assigned = stages.filter((stage) => stage.agentAssignment);
    const assignedHandles = new Set(assigned.map((stage) => stage.agentAssignment!.handle.toLowerCase()));
    for (const stage of assigned) {
      const assignment = stage.agentAssignment!;
      const task = agentTask(assignment.handle);
      const selected = stage.name === selectedName;
      const row = h("div", { class: "stage-row" + (selected ? " selected" : "") });
      const select = h("button", {
        class: "stage-row-select",
        "aria-pressed": String(selected),
        "aria-label": "Show @" + assignment.handle + " desktop details",
        onclick: () => { selectedName = stage.name; render(); },
      },
        dot(task?.color ?? "#9AA1AC", 8),
        h("div", { class: "stage-row-main" },
          h("div", { class: "stage-row-name", text: "@" + assignment.handle }),
          h("div", { class: "stage-row-state", "data-state": stage.status, text: stageLabel(stage) }),
          h("div", { class: "stage-row-task", text: task ? currentTaskText(task) : "No current task reported" }),
        ),
      );
      const joinLabel = stage.status === "current" ? "Here" : stage.status === "unavailable" ? "Unavailable" : "Join";
      const join = h("button", {
        class: "stage-join",
        disabled: busy || stage.status !== "background",
        "aria-label": stage.status === "background" ? "Join @" + assignment.handle + " desktop" : joinLabel,
        onclick: () => void runStageAction("join", stage.name),
      }, joinLabel);
      row.append(select, join);
      rows.append(row);
    }

    const withoutDesktop = State.tasks.filter((task) => !assignedHandles.has(task.name.toLowerCase()));
    if (withoutDesktop.length > 0) {
      rows.append(h("div", { class: "stage-roster-subheading", text: "NO DESKTOP ASSIGNED" }));
      for (const task of withoutDesktop) {
        rows.append(h("div", { class: "stage-row stage-row-unassigned" },
          dot(task.color, 8),
          h("div", { class: "stage-row-main" },
            h("div", { class: "stage-row-name", text: "@" + task.name }),
            h("div", { class: "stage-row-state", text: agentStateLabel(task) }),
            h("div", { class: "stage-row-task", text: currentTaskText(task) }),
          ),
        ));
      }
    }

    if (loaded && assigned.length === 0) {
      rows.prepend(h("div", { class: "stage-empty", text: "No agent desktop yet. Send an agent a task; its assigned desktop appears here." }));
    }

    const selected = assigned.find((stage) => stage.name === selectedName)
      ?? assigned.find((stage) => stage.isCurrent)
      ?? assigned[0];
    selectedName = selected?.name ?? null;
    detailAction.replaceChildren();
    if (!selected) {
      detailTitle.textContent = "Your agents’ desktops";
      detailSession.textContent = "";
      detailStatus.textContent = "";
      activityLabel.textContent = "";
      activity.textContent = loaded ? "When an agent starts a Stage task, its desktop and activity will appear here." : "Connecting to this computer’s Stage registry…";
      cursorNote.hidden = true;
      return;
    }

    const assignment = selected.agentAssignment!;
    const task = agentTask(assignment.handle);
    detailTitle.textContent = "@" + assignment.handle;
    detailSession.textContent = "Session " + assignment.sessionTag;
    detailStatus.textContent = stageLabel(selected);
    detailStatus.dataset.state = selected.status;
    activityLabel.textContent = task?.runState === "working" || task?.runState === "starting" ? "CURRENT TASK" : "CURRENT STATUS";
    activity.textContent = currentTaskText(task);
    cursorNote.hidden = !selected.hasAnchor;
    if (selected.error) {
      status.textContent = selected.error;
      status.hidden = false;
    }
    if (selected.status === "background") {
      detailAction.append(h("button", {
        class: "btn primary stage-join-primary",
        disabled: busy,
        onclick: () => void runStageAction("join", selected.name),
      }, "Join this desktop", svg(ICONS.display, 12)));
    } else if (selected.status === "current" && selected.returnToDesktopId) {
      detailAction.append(h("button", {
        class: "btn secondary stage-join-primary",
        disabled: busy,
        onclick: () => void runStageAction("return", selected.name),
      }, "Return to my desktop"));
    }
  }

  async function refreshStages(silent = false) {
    if (!desktopStages || busy) return;
    busy = true;
    if (!silent) message = "Refreshing agent desktops…";
    render();
    try {
      stages = await desktopStages.list();
      loaded = true;
      if (!silent) message = "";
      if (!selectedName || !stages.some((stage) => stage.name === selectedName)) {
        selectedName = stages.find((stage) => stage.isCurrent && stage.agentAssignment)?.name
          ?? stages.find((stage) => stage.agentAssignment)?.name
          ?? null;
      }
    } catch (error) {
      loaded = true;
      message = "Could not read agent desktops: " + (error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      render();
    }
  }

  async function runStageAction(action: "join" | "return", stageName: string) {
    if (!desktopStages || busy) return;
    busy = true;
    message = action === "join" ? "Joining the agent’s Windows desktop…" : "Returning to your desktop…";
    render();
    try {
      if (action === "join") await desktopStages.activate(stageName);
      else await desktopStages.returnToOwner(stageName);
      stages = await desktopStages.list();
      loaded = true;
      message = action === "join" ? "You joined the agent’s Windows desktop." : "Returned to your desktop.";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      render();
    }
  }

  function startPolling() {
    if (!desktopStages || refreshTimer !== null) return;
    void refreshStages();
    refreshTimer = window.setInterval(() => {
      if (State.mode === "expanded" && State.view === "stage") void refreshStages(true);
    }, 3_000);
  }

  function stopPolling() {
    if (refreshTimer !== null) window.clearInterval(refreshTimer);
    refreshTimer = null;
  }

  render();
  return {
    el,
    activate: startPolling,
    deactivate: stopPolling,
    sync: render,
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
