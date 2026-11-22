// Muse's own two-layer nav, replicated: a narrow icon-only rail (always visible, full height)
// plus a "Chats" panel that slides out as a real layout column -- not a floating dropdown --
// with a search field and a flat chat list. Every chat is one row, single agent or group.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { buddy } from "./buddy";
import { State, type AgentTask } from "../core/state";
import { displayName, plainStep } from "../core/humanize";
import type { ViewActions } from "./views";
import type { IslandViewName } from "../core/layout";

export interface SidebarHost {
  el: HTMLElement;
  sync(): void;
}

function railIcon(path: string, size: number, title: string, onClick: () => void): HTMLElement {
  return h("button", { class: "rail-icon", type: "button", title, "aria-label": title, onclick: onClick }, svg(path, size));
}

/** Same preview text the old Overview rows used: last message, else latest plain-language step. */
function chatPreview(task: AgentTask): string {
  const last = State.chatHistory.filter((m) => m.from === task.name || m.to === task.name).at(-1);
  if (last) return (last.role === "user" ? "You: " : "") + last.content.replace(/\s+/g, " ").trim();
  return plainStep(task, task.steps.at(-1));
}

export function buildSidebar(actions: ViewActions): SidebarHost {
  let panelOpen = false;

  const search = h("input", { class: "chats-panel-search-input", type: "text", placeholder: "Search", "aria-label": "Search chats" }) as HTMLInputElement;
  const searchGroup = h("label", { class: "chats-panel-search" }, svg(ICONS.search, 12, { stroke: 2.2 }), search);
  const newBtn = railIcon(ICONS.compose, 14, "New chat", () => { actions.blip(); State.composeTo = null; actions.setView("prompt"); });
  const panelHead = h("div", { class: "chats-panel-head" }, searchGroup, newBtn);
  const rows = h("div", { class: "chats-panel-rows", role: "listbox", "aria-label": "Chats" });
  const panel = h("div", { class: "chats-panel" }, panelHead, rows);

  // Muse's rail, top to bottom: Chat, Search, (Spaces -- excluded), (Ideas -- no M9R equivalent),
  // Goals -> Agents (what each agent is working on), divider, New chat. Apps (the old model-picker
  // page) is retired -- the composer's own model chip does that job now, right where it's used.
  // Bottom: sound, maximize, then the menu icon that opens Settings.
  const go = (v: IslandViewName) => { actions.blip(); actions.setView(v); };
  const chatsBtn = railIcon(ICONS.railChat, 18, "Chats", () => {
    // First click opens the chat; clicking again while there slides the Chats column in or out.
    if (State.view === "prompt") { actions.blip(); setPanelOpen(!panelOpen); } else go("prompt");
  });
  const searchBtn = railIcon(ICONS.railSearch, 18, "Search", () => {
    actions.blip(); setPanelOpen(true); actions.focusWindow?.(true); search.focus();
  });
  const agentsBtn = railIcon(ICONS.railGoals, 18, "Agents", () => { setPanelOpen(false); go("overview"); });
  const composeBtn = railIcon(ICONS.railNew, 18, "New chat", () => { State.composeTo = null; go("prompt"); });
  const soundBtn = railIcon(ICONS.railSoundOff, 18, "Sound", () => actions.toggleSound());
  // Hidden: core/sound.ts plays nothing yet, so this toggle had no audible effect. Kept wired
  // (not deleted) so it comes back by flipping this line once the pill has real sounds.
  soundBtn.hidden = true;
  const updateBtn = railIcon(ICONS.arrowUp, 18, "Update available", () => { actions.blip(); actions.applyUpdate?.(); });
  updateBtn.hidden = true;
  updateBtn.classList.add("rail-icon-update");
  const gearBtn = railIcon(ICONS.railMenu, 18, "Settings", () => { setPanelOpen(false); actions.blip(); actions.toggleSettings(); });
  for (const b of [chatsBtn, searchBtn, agentsBtn, composeBtn, soundBtn, updateBtn, gearBtn]) {
    for (const p of b.querySelectorAll("path")) {
      p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.7");
      p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    }
  }
  let soundKey = "";
  let updateKey = "";
  function setIcon(b: HTMLElement, path: string) {
    b.querySelector("path")?.setAttribute("d", path);
  }

  const rail = h("div", { class: "app-rail" },
    h("div", { class: "app-rail-top" }, chatsBtn, searchBtn, agentsBtn, h("i", { class: "app-rail-divider" }), composeBtn),
    h("div", { class: "app-rail-bottom" }, soundBtn, updateBtn, gearBtn),
  );

  const el = h("div", { class: "shell-nav" }, rail, panel);

  function setPanelOpen(next: boolean) {
    panelOpen = next;
    panel.classList.toggle("on", panelOpen);
    chatsBtn.classList.toggle("on", panelOpen);
  }

  function highlightFor(): IslandViewName {
    return State.view;
  }

  let key = "";

  function sync() {
    const view = highlightFor();
    chatsBtn.classList.toggle("on", view === "prompt" || panelOpen);
    agentsBtn.classList.toggle("on", view === "overview" || view === "empty");
    gearBtn.classList.toggle("on", State.settingsOpen);
    const sk = State.settings.soundEnabled ? "on" : "off";
    if (sk !== soundKey) {
      soundKey = sk;
      setIcon(soundBtn, sk === "on" ? ICONS.railSoundOn : ICONS.railSoundOff);
      soundBtn.title = sk === "on" ? "Sound on" : "Sound off";
      soundBtn.setAttribute("aria-pressed", String(sk === "on"));
    }
    const version = actions.updateAvailable?.() ?? null;
    const uk = version ?? "";
    if (uk !== updateKey) {
      updateKey = uk;
      updateBtn.hidden = !version;
      if (version) {
        updateBtn.title = `Update to v${version}`;
        updateBtn.setAttribute("aria-label", updateBtn.title);
      }
    }

    const items = State.tasks.map((task) => ({ task, preview: chatPreview(task), pending: State.approvals.filter((a) => a.agent === task.id).length }));
    const needle = search.value.trim().toLowerCase();
    const shown = needle ? items.filter((i) => `${displayName(i.task)} ${i.preview}`.toLowerCase().includes(needle)) : items;
    const next = JSON.stringify([State.focusId, needle, items.map((i) => [i.task.id, i.task.color, i.task.state, i.preview, i.pending])]);
    if (next === key) return;
    key = next;

    if (!shown.length) {
      rows.replaceChildren(h("div", { class: "mp-empty" }, h("div", { class: "mp-empty-title", text: items.length ? "No matches" : "No chats yet" }),
        items.length ? "Try a different name." : "Connected agents show up here."));
      return;
    }
    rows.replaceChildren(...shown.map(({ task, preview, pending }) => h("button", {
      class: "home-row chats-panel-row" + (task.id === State.focusId ? " on" : ""), type: "button",
      role: "option", "aria-selected": task.id === State.focusId ? "true" : "false",
      "aria-label": `${displayName(task)}: ${preview}`,
      onclick: () => { actions.blip(); actions.setFocus(task.id); actions.setView("prompt"); },
    },
      h("span", { class: "home-row-thumb", style: `--tint:${task.color}` }, buddy(task.color, 28, { seed: task.id })),
      h("span", { class: "home-row-body" },
        h("span", { class: "home-row-head" },
          h("span", { class: "home-row-name", text: displayName(task) }),
          pending ? h("span", { class: "home-row-badge", text: String(pending) }) : null,
        ),
        h("span", { class: "home-row-preview", text: preview }),
      ),
    )));
  }

  search.addEventListener("input", () => { key = ""; sync(); });

  return { el, sync };
}
