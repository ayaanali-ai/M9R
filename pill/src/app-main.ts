// Entry point for the full-window app (not the compact pill overlay). Reuses the exact same
// data layer and group-chat logic as the pill (core/state, shells/desktop, views/composer) so
// the two surfaces can never drift apart on what a message or an agent actually is -- only the
// layout around them differs.

import "./style.css";
import "./app-style.css";
import { h, svg } from "./views/dom";
import { providerLogo } from "./views/provider";
import { buildPrompt } from "./views/composer";
import { ICONS } from "./views/icons";
import type { ViewActions } from "./views/views";
import { State } from "./core/state";
import { createDesktopTransport, tauriInvoke } from "./shells/desktop";

type Theme = "light" | "dark";

// Every surface colour comes from CSS custom properties keyed off this attribute, so other modes
// later are a new [data-theme] block in app-style.css, not new markup.
function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

const icon = (path: string, size = 15) => svg(path, size, { stroke: 1.7 });

function iconBtn(path: string, title: string, extra = "") {
  // visual placeholder, not wired to real data yet
  return h("button", { class: `app-icon-btn ${extra}`.trim(), type: "button", title, onclick: () => {} }, icon(path));
}

/**
 * A stable name for the tab/header, not a live status line. `AgentTask.task` is the agent's
 * current activity ("Ready (Claude managed process; first turn initializes provider)", "Running
 * npm test") -- real, but it changes every few seconds and was never meant to label the whole
 * conversation, which is why it showed up here as raw internal status text. The first thing the
 * owner actually typed is the real name for the session, same as Clonk's own tab naming.
 */
function sessionTitle(): string {
  const firstUserMessage = State.chatHistory.find((m) => m.role === "user");
  if (firstUserMessage) {
    const clipped = firstUserMessage.content.trim().replace(/\s+/g, " ");
    return clipped.length > 48 ? `${clipped.slice(0, 48)}…` : clipped;
  }
  const t = State.tasks.find((x) => x.id === State.focusId) ?? State.tasks[0];
  return t ? `@${t.name}` : "New session";
}

async function main() {
  setTheme("light");
  const root = document.getElementById("root");
  if (!root) return;
  const invoke = tauriInvoke();
  if (!invoke) {
    root.append(h("div", { class: "app-boot-error", text: "This window only runs inside the M9R desktop app." }));
    return;
  }
  const transport = createDesktopTransport(invoke);

  // --- Tab strip. Single tab mirrors the focused session; no real multi-tab switching yet. ---
  const tabLogo = h("span", { class: "app-tab-logo" });
  const tabLabel = h("span", { class: "app-tab-label" });
  const tabTimer = h("span", { class: "app-tab-timer" });
  tabTimer.hidden = true;
  const tabbar = h(
    "header",
    { class: "app-tabbar" },
    h("button", { class: "app-icon-btn app-orange", type: "button", title: "M9R", onclick: () => {} }, icon(ICONS.star)), // visual placeholder, not wired to real data yet
    iconBtn(ICONS.sliders, "Sessions"),
    h("div", { class: "app-tab on" }, tabLogo, tabLabel, tabTimer),
    iconBtn(ICONS.plus, "New tab"),
  );

  // --- Left: conversation panel wrapping the real composer from buildPrompt. ---
  const convTitle = h("span", { class: "app-conv-title" });
  const convTimer = h("span", { class: "app-conv-timer" });
  convTimer.hidden = true;
  const convHead = h("div", { class: "app-conv-head" }, h("span", { class: "app-orange-ico" }, icon(ICONS.star, 13)), convTitle, convTimer);

  const actions: ViewActions = {
    setView() {},
    collapse() {},
    setFocus(id) { State.setFocus(id); },
    decide() {},
    async send(text) {
      const reply = await transport.send(text);
      return reply;
    },
    canAllowForADay() { return false; },
    toggleSound() {},
    setAutoClose() {},
    blip() {},
  };
  const prompt = buildPrompt(actions, () => {});
  // .view's visibility is normally toggled by the Island's view-switcher (adds/removes "on"
  // when the pill changes screens); this window has only one screen, so it's always on.
  prompt.el.classList.add("on");

  // visual placeholder, not wired to real data yet: action summaries, checkpoint and Undo/Review
  // show the Clonk pattern until the bridge reports real tool-activity/checkpoint events.
  const summary = (text: string) => h("div", { class: "app-summary" }, icon(ICONS.doc, 13), h("span", { text }));
  const mock = h(
    "div",
    { class: "app-mock" },
    summary("Explored 23 files, ran 2 commands"),
    h("div", { class: "app-checkpoint" }, h("span", {}, icon(ICONS.timer, 11), "checkpoint 6:58 AM")),
    h(
      "div",
      { class: "app-summary-row" },
      summary("Created 3 products in Stripe"),
      h("button", { class: "app-chip ghost", type: "button", text: "Undo", onclick: () => {} }),
      h("button", { class: "app-chip solid", type: "button", text: "Review", onclick: () => {} }),
    ),
  );
  const log = prompt.el.querySelector(".chat-log");
  log?.parentElement?.insertBefore(mock, log.nextSibling);

  // visual placeholder, not wired to real data yet: attach button in front of the real picker.
  prompt.el.querySelector(".chat-bar")?.prepend(
    h("button", { class: "app-bar-plus", type: "button", title: "Attach", onclick: () => {} }, icon(ICONS.plus, 14)),
  );

  const conv = h("section", { class: "app-panel app-conv" }, convHead, prompt.el);

  // --- Right: preview chrome. Real live-preview embedding is future work, out of scope here. ---
  const preview = h(
    "section",
    { class: "app-panel app-preview" },
    h(
      "div",
      { class: "app-browser-bar" },
      h("span", { class: "app-browser-ico" }, icon(ICONS.display)),
      iconBtn(ICONS.chevronLeft, "Back"),
      iconBtn(ICONS.chevronRight, "Forward"),
      iconBtn(ICONS.timer, "Reload"),
      h("input", { class: "app-url", value: "http://localhost:1431", readonly: true, "aria-label": "Preview URL" }), // visual placeholder, not wired to real data yet
      iconBtn(ICONS.stack, "Fullscreen"),
      iconBtn(ICONS.display, "Device"),
      iconBtn(ICONS.bubble, "Comment"),
      iconBtn(ICONS.stack, "Layers"),
    ),
    h("div", { class: "app-preview-body" }, h("div", { class: "app-preview-empty" }, icon(ICONS.display, 28), h("span", { text: "Live preview will appear here" }))),
  );

  const fab = h("button", { class: "app-fab", type: "button", title: "M9R", onclick: () => {} }, icon(ICONS.star, 18)); // visual placeholder, not wired to real data yet

  root.append(h("div", { class: "app-shell" }, tabbar, h("div", { class: "app-split" }, conv, preview), fab));
  prompt.activate?.();

  let lastKey = "";
  function renderChrome() {
    const t = State.tasks.find((x) => x.id === State.focusId) ?? State.tasks[0];
    // The title only needs to recompute when the focused agent, its state, the task list, or the
    // first message change -- not on every "doing" update, since the title no longer reads that.
    const key = `${t?.id}:${t?.state}:${State.tasks.length}:${State.chatHistory[0]?.id ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;
    const title = sessionTitle();
    tabLabel.textContent = title;
    convTitle.textContent = title;
    tabLogo.replaceChildren(t ? providerLogo(t.provider, 14, t.state) : icon(ICONS.bubble, 12));
  }

  // Live timer text, same idea as the pill's per-frame tick() -- this window has no render loop,
  // so a 1s interval stands in for it. Hidden/shown state only needs to change when a timer
  // actually starts or stops, which renderChrome's own key already reacts to via State.subscribe.
  function tickTimers() {
    // The current shared state intentionally does not invent start timestamps.
    // Keep the app chrome stable until the host supplies real timing data.
    tabTimer.hidden = true;
    convTimer.hidden = true;
  }

  State.subscribe(() => {
    renderChrome();
    prompt.sync();
    tickTimers();
  });

  transport.subscribe((snapshot) => {
    State.apply(snapshot);
  });
  renderChrome();
  prompt.sync();
  tickTimers();
  setInterval(tickTimers, 1000);
}

void main();
