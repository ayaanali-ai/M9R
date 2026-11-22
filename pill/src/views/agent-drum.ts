// The top agent drum: Muse shows its one persona's avatar at the top-centre of the chat and
// clicking it opens the avatar panel. M9R runs several agents at once, so the same top-centre
// slot is a horizontal drum of their avatars (provider logos until real avatars exist): scroll,
// drag or arrow through it to change which agent is focused; click the centred avatar to open
// that agent's panel. Clicking a side avatar brings it to the centre first.

import { h } from "./dom";
import { providerLogo } from "./provider";
import { clamp } from "../core/anim";
import { State, type AgentTask } from "../core/state";
import { botGlowColor } from "../core/layout";
import { displayName, plainStatus } from "../core/humanize";
import type { ViewActions } from "./views";

/** Horizontal distance between neighbouring avatars, px. */
const GAP = 40;
/** Avatars further than this from centre (in slots) are not drawn. */
const REACH = 2.4;
/** One wheel notch moves one slot; further notches inside this window are ignored. */
const WHEEL_COOLDOWN_MS = 140;

export interface AgentDrum {
  el: HTMLElement;
  sync(): void;
}

interface Item { id: string; el: HTMLButtonElement; key: string }

export function buildAgentDrum(actions: ViewActions): AgentDrum {
  const track = h("div", { class: "agent-drum-track" });
  const label = h("button", { class: "agent-drum-label", type: "button", tabindex: "-1" });
  const el = h("div", { class: "agent-drum", role: "listbox", tabindex: "0", "aria-label": "Agents — scroll to switch, click the centre to open" }, track, label);

  const items = new Map<string, Item>();
  let order: AgentTask[] = [];
  /** Fractional centre index while dragging; integer when at rest. */
  let pos = 0;
  let drag: { x: number; start: number; moved: boolean } | null = null;
  let lastWheel = 0;
  let labelKey = "";

  const indexOf = (id: string | null | undefined) => order.findIndex((t) => t.id === id);

  function layout(animate: boolean) {
    el.classList.toggle("dragging", !animate);
    order.forEach((task, i) => {
      const item = items.get(task.id);
      if (!item) return;
      const d = i - pos;
      const a = Math.abs(d);
      const shown = a <= REACH;
      // Curve away like a drum seen from the front: neighbours shrink, tuck in and fade.
      const x = Math.sign(d) * (a <= 1 ? a * GAP : GAP + (a - 1) * GAP * 0.72);
      const scale = 1 - Math.min(a, 2) * 0.2;
      item.el.style.transform = `translateX(${x.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      item.el.style.opacity = shown ? String(clamp(1 - Math.max(0, a - 0.6) * 0.42, 0, 1)) : "0";
      item.el.style.zIndex = String(10 - Math.round(a * 2));
      item.el.style.pointerEvents = shown ? "auto" : "none";
      const centre = a < 0.5;
      item.el.classList.toggle("centre", centre);
      item.el.setAttribute("aria-selected", String(centre));
      item.el.tabIndex = -1;
    });
  }

  /** Bring slot `i` to the centre and make that agent the focused one. */
  function centreOn(i: number) {
    const target = order[clamp(Math.round(i), 0, Math.max(0, order.length - 1))];
    pos = indexOf(target?.id);
    layout(true);
    if (target && target.id !== State.focusTask?.id) actions.setFocus(target.id);
  }

  function paintLabel() {
    const task = order[Math.round(pos)];
    const status = task ? plainStatus(task) : null;
    const key = task ? `${task.id}|${displayName(task)}|${status?.label}|${task.state}` : "";
    if (key === labelKey) return;
    labelKey = key;
    label.hidden = !task;
    if (!task || !status) return;
    label.replaceChildren(h("span", { text: displayName(task) }));
    label.style.setProperty("--tone", task.state === "idle" || task.state === "sleeping" ? "#3ad07a" : botGlowColor(task.state));
    label.title = `${displayName(task)} · ${status.label}`;
  }

  function makeItem(task: AgentTask): Item {
    const b = h("button", { class: "agent-drum-item", type: "button", role: "option" }) as HTMLButtonElement;
    b.addEventListener("click", () => {
      if (drag?.moved) return;
      const i = indexOf(task.id);
      if (i < 0) return;
      // The centred avatar is Muse's avatar: it opens the panel, every time.
      if (Math.round(pos) === i) { actions.blip(); actions.openIdentity(task.id); return; }
      actions.blip();
      centreOn(i);
    });
    return { id: task.id, el: b, key: "" };
  }

  // ── Input: wheel (either axis), drag, arrow keys ───────────────────
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const now = performance.now();
    if (Math.abs(delta) < 4 || now - lastWheel < WHEEL_COOLDOWN_MS) return;
    lastWheel = now;
    centreOn(Math.round(pos) + Math.sign(delta));
  }, { passive: false });

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, start: pos, moved: false };
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 4) { drag.moved = true; el.setPointerCapture(e.pointerId); }
    if (!drag.moved) return;
    const max = Math.max(0, order.length - 1);
    const raw = drag.start - dx / GAP;
    // Resist past either end instead of stopping dead.
    pos = raw < 0 ? raw * 0.3 : raw > max ? max + (raw - max) * 0.3 : raw;
    layout(false);
  });
  const release = () => {
    if (!drag) return;
    const moved = drag.moved;
    if (moved) centreOn(pos);
    // Let this pointer's click see `moved` before clearing it.
    window.setTimeout(() => { drag = null; }, 0);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);

  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      centreOn(Math.round(pos) + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const task = order[Math.round(pos)];
      if (task) actions.openIdentity(task.id);
    }
  });
  label.addEventListener("click", () => {
    const task = order[Math.round(pos)];
    if (task) { actions.blip(); actions.openIdentity(task.id); }
  });

  return {
    el,
    sync() {
      // Stable order (the host's own), so avatars never slide out from under the owner's hand.
      order = State.tasks.slice();
      for (const [id, item] of items) {
        if (!order.some((t) => t.id === id)) { item.el.remove(); items.delete(id); }
      }
      for (const task of order) {
        let item = items.get(task.id);
        if (!item) {
          item = makeItem(task);
          items.set(task.id, item);
          track.append(item.el);
        }
        const key = `${task.provider}|${task.state}|${displayName(task)}`;
        if (key !== item.key) {
          item.key = key;
          item.el.replaceChildren(providerLogo(task.provider, "fill"));
          item.el.dataset.state = task.state;
          item.el.title = displayName(task);
          item.el.setAttribute("aria-label", displayName(task));
        }
      }
      el.hidden = order.length === 0;
      // Follow focus (an approval arriving, a chat row picked) unless the owner is mid-drag.
      if (!drag?.moved) {
        const at = indexOf(State.focusTask?.id);
        if (at >= 0 && at !== pos) { pos = at; layout(true); }
        else layout(true);
      }
      paintLabel();
    },
  };
}
