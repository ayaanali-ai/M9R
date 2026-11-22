// Agent identity panel -- a literal replica of Muse's "click the agent's avatar" panel:
// avatar + name + connected dot, a 4-icon tab row (Activity / Approvals history / Identity / Inbox),
// and the active tab's list below it. Our own spin comes later; this pass is the shape as-is.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { providerLogo } from "./provider";
import { State, type AgentTask, type ApprovalHistoryEntry, type ActivityEntry } from "../core/state";
import { displayName } from "../core/humanize";
import type { ViewActions, ViewHost } from "./views";

type Tab = "activity" | "approvals" | "identity" | "inbox";

const TABS: ReadonlyArray<{ id: Tab; icon: keyof typeof ICONS; label: string }> = [
  { id: "activity", icon: "list", label: "Activity" },
  { id: "approvals", icon: "shieldCheck", label: "Approvals history" },
  { id: "identity", icon: "paperclip", label: "Identity" },
  { id: "inbox", icon: "mail", label: "Inbox" },
];

function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function decisionLabel(entry: ApprovalHistoryEntry): string {
  if (entry.decision === "deny") return `Denied · ${timeAgo(entry.decidedAt)}`;
  if (entry.decision === "allow_day") return `Allowed for the day · ${timeAgo(entry.decidedAt)}`;
  return `Allowed for this session · ${timeAgo(entry.decidedAt)}`;
}

function emptyState(icon: keyof typeof ICONS, headline: string, body: string, cta?: { label: string; onClick: () => void }): HTMLElement {
  const wrap = h("div", { class: "identity-empty" },
    h("div", { class: "identity-empty-icon" }, svg(ICONS[icon], 28)),
    h("p", { class: "identity-empty-head", text: headline }),
    h("p", { class: "identity-empty-body", text: body }),
  );
  if (cta) {
    const btn = h("button", { class: "btn primary identity-empty-cta", text: cta.label });
    btn.addEventListener("click", cta.onClick);
    wrap.append(btn);
  }
  return wrap;
}

function activityTab(task: AgentTask): HTMLElement {
  const entries = State.activityLog.filter((e) => e.agent === task.id).slice(0, 30);
  if (entries.length === 0) {
    return emptyState("list", "Nothing yet", `${displayName(task)} hasn't logged any activity this session.`);
  }
  const list = h("div", { class: "identity-list" });
  for (const entry of entries) {
    list.append(h("div", { class: "identity-row" },
      h("span", { class: "identity-row-check" }, svg(ICONS.check, 13)),
      h("div", { class: "identity-row-text" },
        h("span", { class: "identity-row-title", text: entry.text }),
        h("span", { class: "identity-row-time", text: timeAgo(entry.at) }),
      ),
    ));
  }
  return list;
}

function approvalsTab(task: AgentTask): HTMLElement {
  const entries = State.approvalHistory.filter((e) => e.agent === task.id).slice(0, 30);
  if (entries.length === 0) {
    return emptyState("shieldCheck", "No decisions yet", `Approvals ${displayName(task)} asks for, once decided, show up here.`);
  }
  const list = h("div", { class: "identity-list" });
  for (const entry of entries) {
    list.append(h("div", { class: "identity-row" },
      h("span", { class: "identity-row-check" }, svg(ICONS.shieldCheck, 13)),
      h("div", { class: "identity-row-text" },
        h("span", { class: "identity-row-title", text: entry.title || "Approval" }),
        h("span", { class: "identity-row-time", text: decisionLabel(entry) }),
      ),
    ));
  }
  return list;
}

function identityTab(task: AgentTask): HTMLElement {
  const doc = State.identityDocs.get(task.id) ?? {};
  const wrap = h("div", { class: "identity-doc" });

  const tiles = h("div", { class: "identity-tiles" },
    h("div", { class: "identity-tile identity-tile-soul" },
      h("span", { class: "identity-tile-label", text: "Soul" }),
      h("span", { class: "identity-tile-access", text: "Access with care" }),
      h("span", { class: "identity-tile-date", text: new Date().toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "2-digit" }) }),
      svg(ICONS.heart, 16),
    ),
    h("div", { class: "identity-tile identity-tile-memory" },
      h("span", { class: "identity-tile-label", text: "Memory" }),
      h("span", { class: "identity-tile-access", text: "Access with care" }),
      h("span", { class: "identity-tile-date", text: new Date().toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "2-digit" }) }),
      svg(ICONS.heart, 16),
    ),
  );

  const field = (key: "name" | "character" | "vibe" | "emoji", label: string, placeholder: string): HTMLElement => {
    const row = h("label", { class: "identity-field" },
      h("span", { class: "identity-field-label", text: label }),
    );
    const input = h("input", { class: "identity-field-input", type: "text", placeholder, value: doc[key] ?? "" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      State.setIdentityDoc(task.id, { ...State.identityDocs.get(task.id), [key]: input.value });
    });
    row.append(input);
    return row;
  };

  wrap.append(
    tiles,
    h("p", { class: "identity-doc-note", text: "This is how M9R describes itself for this agent. Fill it in as you figure out who it is." }),
    field("name", "Name", task.name),
    field("character", "Character", "an AI? a familiar? something stranger?"),
    field("vibe", "Vibe", "how it comes across: sharp, warm, calm, playful?"),
    field("emoji", "Emoji", "its signature, if you want one"),
  );
  return wrap;
}

function inboxTab(): HTMLElement {
  return emptyState("mail", "Give this agent an email address", "It doesn't have one yet.", { label: "Create an email", onClick: () => {} });
}

/** Muse's avatar panel: an in-flow right-hand column (not a view that replaces the chat), with a
 * plain round close button top-right. The island mounts `el` and toggles it from State.identityOpen. */
export function buildIdentity(actions: ViewActions): ViewHost {
  const close = h("button", { class: "identity-close", type: "button", title: "Close panel", "aria-label": "Close panel",
    onclick: () => actions.closeIdentity() }, svg(ICONS.xmark, 12));
  const avatar = h("div", { class: "identity-avatar" });
  const editBadge = h("button", { class: "identity-avatar-edit", type: "button", "aria-label": "Edit avatar" }, svg(ICONS.pencil, 11));
  const name = h("h2", { class: "identity-name" });
  const status = h("div", { class: "identity-status" }, h("span", { class: "identity-status-dot" }), h("span", { class: "identity-status-text" }));
  const header = h("div", { class: "identity-header" },
    h("div", { class: "identity-avatar-wrap" }, avatar, editBadge),
    name,
    status,
  );

  const tabRow = h("div", { class: "identity-tabs", role: "tablist" });
  const tabButtons = new Map<Tab, HTMLElement>();
  let active: Tab = "activity";
  for (const t of TABS) {
    const btn = h("button", { class: "identity-tab", type: "button", role: "tab", "aria-label": t.label }, svg(ICONS[t.icon], 16));
    btn.addEventListener("click", () => { if (active !== t.id) { active = t.id; render(); } });
    tabButtons.set(t.id, btn);
    tabRow.append(btn);
  }

  const body = h("div", { class: "identity-body" });
  const el = h("aside", { class: "identity-panel", "aria-label": "Agent" },
    h("div", { class: "identity-view" }, close, header, tabRow, body));

  let fingerprint = "";

  function render() {
    for (const [id, btn] of tabButtons) btn.classList.toggle("is-active", id === active);
    const task = State.focusTask;
    clear(body);
    if (!task) {
      body.append(emptyState("list", "No agent selected", "Pick an agent to see its activity."));
      return;
    }
    if (active === "activity") body.append(activityTab(task));
    else if (active === "approvals") body.append(approvalsTab(task));
    else if (active === "identity") body.append(identityTab(task));
    else body.append(inboxTab());
  }

  return {
    el,
    sync() {
      const task = State.focusTask;
      const key = JSON.stringify([
        task?.id, active,
        State.activityLog.filter((e: ActivityEntry) => e.agent === task?.id).length,
        State.approvalHistory.filter((e) => e.agent === task?.id).length,
        task && State.identityDocs.get(task.id),
      ]);
      clear(avatar);
      if (task) {
        avatar.append(providerLogo(task.provider, 30));
        name.textContent = displayName(task);
        status.classList.toggle("is-connected", task.runState !== "failed" && task.runState !== "not_connected");
        status.querySelector(".identity-status-text")!.textContent =
          task.runState === "failed" || task.runState === "not_connected" ? "Disconnected" : "Connected";
      } else {
        name.textContent = "No agent";
        status.querySelector(".identity-status-text")!.textContent = "";
      }
      if (key !== fingerprint) {
        fingerprint = key;
        render();
      }
    },
  };
}
