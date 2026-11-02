// The Drum: every connected agent on one picker wheel (UIPickerView anatomy). The centred row is the focused agent and
// merges into the island's big glowing mark; rows above and below curve away on a cylinder. Release physics use Apple's
// published projection and rubber-band functions (WWDC18 "Designing Fluid Interfaces"), settled by a damped spring.

import { h } from "./dom";
import { providerLogo } from "./provider";
import { Spring, clamp } from "../core/anim";
import { State, type AgentTask, type AgentRunState } from "../core/state";
import { botGlowColor, botGlowOpacity } from "../core/layout";
import { plainStatus, displayName } from "../core/humanize";

/** Vertical travel, in px, that moves the wheel by one row while dragging. */
const ROW_PX = 34;
/** UIScrollView.DecelerationRate.normal. */
const DECEL = 0.998;
/** Manual spin holds the wheel still against auto-centring for this long. */
const HOLD_MS = 8000;

// Row placement by signed distance from centre: y offset (px from the lens centre), scale, opacity, tilt.
const STOPS = [
  { d: 0, y: -12, s: 1, o: 1, r: 0 },
  { d: 1, y: 52, s: 0.86, o: 0.8, r: 22 },
  { d: 2, y: 67, s: 0.66, o: 0.3, r: 40 },
  { d: 2.6, y: 74, s: 0.56, o: 0, r: 52 },
];
const STOPS_UP = [
  { d: 0, y: -12, s: 1, o: 1, r: 0 },
  { d: 1, y: -50, s: 0.86, o: 0.8, r: 22 },
  { d: 2, y: -65, s: 0.66, o: 0.3, r: 40 },
  { d: 2.6, y: -73, s: 0.56, o: 0, r: 52 },
];

const PRIORITY: Record<AgentRunState, number> = {
  blocked: 0, failed: 1, working: 2, starting: 3, waiting: 3, idle: 4, seen: 4, stopped: 5, unknown: 6, not_connected: 7,
};

function rank(t: AgentTask): number {
  return t.state === "approval" ? -1 : PRIORITY[t.runState] ?? 6;
}

function sample(dist: number) {
  const table = dist < 0 ? STOPS_UP : STOPS;
  const a = Math.abs(dist);
  for (let i = 1; i < table.length; i++) {
    const lo = table[i - 1];
    const hi = table[i];
    if (a <= hi.d) {
      const t = (a - lo.d) / (hi.d - lo.d);
      return { y: lo.y + (hi.y - lo.y) * t, s: lo.s + (hi.s - lo.s) * t, o: lo.o + (hi.o - lo.o) * t, r: (lo.r + (hi.r - lo.r) * t) * Math.sign(dist) };
    }
  }
  const last = table[table.length - 1];
  return { y: last.y, s: last.s, o: 0, r: last.r * Math.sign(dist) };
}

/** Apple's rubber band: resistance grows the further past the end you pull. */
function rubber(over: number, dim: number, c = 0.55): number {
  const sign = Math.sign(over);
  const x = Math.abs(over);
  return sign * (1 - 1 / ((x * c) / dim + 1)) * dim;
}

/** Where a flick comes to rest, per UIScrollView deceleration. Velocity in rows/s. */
function project(velocity: number): number {
  return ((velocity / 1000) * DECEL) / (1 - DECEL);
}

interface RowView {
  id: string;
  el: HTMLElement;
  mark: HTMLElement;
  glow: HTMLElement;
  name: HTMLElement;
  tag: HTMLElement;
  key: string;
}

export interface Drum {
  el: HTMLElement;
  /** Re-reads State; call on every sync. */
  sync(): void;
}

/** `lens` is the centred agent's live activity; it shows only while the wheel is at rest on a row. */
export function buildDrum(lens: HTMLElement, onFocus: (id: string) => void, onDetent: () => void): Drum {
  const wheel = h("div", { class: "drum-wheel" });
  const band = h("div", { class: "drum-band" });
  const rail = h("div", { class: "drum-rail", role: "tablist", "aria-label": "Agents" });
  lens.classList.add("drum-lens");
  const el = h("div", { class: "drum", tabindex: "0", "aria-roledescription": "agent wheel" }, band, wheel, lens, rail);

  const pos = new Spring(0, 0.42, 0.86);
  const rows = new Map<string, RowView>();
  let order: AgentTask[] = [];
  let heldUntil = 0;
  let dragging: { startY: number; startPos: number; lastY: number; lastT: number; v: number } | null = null;
  let lastDetent = 0;
  let raf = 0;
  let lastFrame = 0;
  let wheelTimer = 0;
  let railKey = "";
  let first = true;

  const maxIndex = () => Math.max(0, order.length - 1);

  function focusIndex(i: number) {
    const t = order[i];
    if (t && t.id !== State.focusTask?.id) onFocus(t.id);
  }

  function snapTo(index: number, velocity = 0) {
    pos.target = clamp(Math.round(index), 0, maxIndex());
    pos.velocity = velocity;
    run();
  }

  function hold() {
    heldUntil = performance.now() + HOLD_MS;
  }

  function run() {
    if (raf) return;
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!dragging) pos.step(dt);
    if (!dragging && pos.settled) pos.set(pos.target);
    layout();
    const detent = clamp(Math.round(pos.value), 0, maxIndex());
    if (detent !== lastDetent) {
      lastDetent = detent;
      // Only a spin the owner started may move focus; the wheel's own re-centring just follows it.
      if (dragging || now < heldUntil) {
        onDetent();
        focusIndex(detent);
      }
    }
    if (dragging || !pos.settled) run();
  }

  function layout() {
    const p = pos.value;
    order.forEach((task, i) => {
      const row = rows.get(task.id);
      if (!row) return;
      const dist = i - p;
      const hidden = Math.abs(dist) > 2.6;
      row.el.style.visibility = hidden ? "hidden" : "visible";
      if (hidden) return;
      const k = sample(dist);
      row.el.style.transform = `translate3d(0, ${k.y}px, 0) rotateX(${-k.r}deg) scale(${k.s})`;
      row.el.style.opacity = String(k.o);
      row.el.style.zIndex = String(10 - Math.round(Math.abs(dist) * 2));
      // The centred row hands its mark to the island's big glowing mark.
      row.mark.style.opacity = String(clamp(Math.abs(dist) * 1.6 - 0.2, 0, 1));
      row.tag.style.opacity = String(clamp(1 - Math.abs(dist) * 0.7, 0, 1));
      row.name.style.opacity = String(clamp(1.7 - Math.abs(dist) * 0.75, 0, 1));
      row.el.classList.toggle("centre", Math.abs(dist) < 0.5);
      row.el.setAttribute("aria-selected", String(Math.abs(dist) < 0.5));
    });
    band.style.opacity = order.length > 0 ? "1" : "0";
    const off = Math.abs(p - Math.round(p));
    lens.style.opacity = String(clamp(1 - off * 3.2, 0, 1));
    lens.style.transform = `translateY(${off * 10}px)`;
    // The rail's active capsule tracks the wheel continuously, not per detent.
    rail.style.setProperty("--p", String(order.length > 1 ? p / maxIndex() : 0));
  }

  function makeRow(task: AgentTask): RowView {
    const glow = h("span", { class: "drum-glow" });
    const mark = h("span", { class: "drum-mark" }, glow, providerLogo(task.provider, 11));
    const name = h("span", { class: "drum-name" });
    const tag = h("span", { class: "drum-tag" });
    const el = h("button", { class: "drum-row", role: "tab", tabindex: "-1" }, mark, name, tag);
    el.addEventListener("click", () => {
      if (moved) return;
      const i = order.findIndex((t) => t.id === task.id);
      if (i < 0) return;
      hold();
      snapTo(i);
    });
    return { id: task.id, el, mark, glow, name, tag, key: "" };
  }

  function paint(row: RowView, task: AgentTask) {
    const status = plainStatus(task);
    const label = displayName(task);
    const key = `${label}|${task.state}|${task.runState}|${status.label}`;
    if (key === row.key) return;
    row.key = key;
    row.name.textContent = label;
    row.tag.textContent = status.label;
    row.tag.style.setProperty("--tone", status.color);
    row.tag.classList.toggle("live", status.live);
    row.glow.style.setProperty("--glow", botGlowColor(task.state));
    row.glow.style.setProperty("--glow-o", String(botGlowOpacity(task.state)));
    row.el.title = `${label} · ${status.label}`;
  }

  function paintRail() {
    const key = order.map((t) => `${t.id}:${t.state}`).join("|");
    if (key === railKey) return;
    railKey = key;
    rail.replaceChildren();
    rail.style.display = order.length > 1 ? "" : "none";
    rail.style.setProperty("--n", String(order.length));
    rail.append(h("span", { class: "drum-rail-thumb" }));
    order.forEach((task, i) => {
      const pip = h("button", { class: "drum-pip", title: displayName(task), "aria-label": displayName(task) });
      pip.style.setProperty("--tone", task.state === "idle" || task.state === "sleeping" ? "#4b4f57" : botGlowColor(task.state));
      pip.addEventListener("click", () => { hold(); snapTo(i); });
      rail.append(pip);
    });
  }

  // ── Input: drag, wheel, keys ──────────────────────────────────────

  let moved = false;
  el.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".drum-pip")) return;
    dragging = { startY: e.clientY, startPos: pos.value, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    moved = false;
    el.setPointerCapture(e.pointerId);
    run();
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - dragging.startY;
    if (Math.abs(dy) > 3) moved = true;
    const raw = dragging.startPos - dy / ROW_PX;
    const max = maxIndex();
    pos.value = raw < 0 ? rubber(raw, 1) : raw > max ? max + rubber(raw - max, 1) : raw;
    const dtMs = Math.max(1, e.timeStamp - dragging.lastT);
    const inst = (-(e.clientY - dragging.lastY) / ROW_PX) / (dtMs / 1000);
    dragging.v = dragging.v * 0.6 + inst * 0.4;
    dragging.lastY = e.clientY;
    dragging.lastT = e.timeStamp;
  });
  const release = () => {
    if (!dragging) return;
    const v = dragging.v;
    dragging = null;
    if (!moved) return run();
    hold();
    snapTo(pos.value + project(v), v);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    hold();
    const max = maxIndex();
    const next = pos.value + e.deltaY / (ROW_PX * 3);
    pos.value = clamp(next, -0.35, max + 0.35);
    pos.target = pos.value;
    pos.velocity = 0;
    run();
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => snapTo(pos.value), 90);
  }, { passive: false });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    hold();
    snapTo(Math.round(pos.target) + (e.key === "ArrowDown" ? 1 : -1));
  });

  return {
    el,
    sync() {
      const tasks = State.tasks;
      const interacting = dragging != null || performance.now() < heldUntil;
      // Re-rank only while the owner isn't steering, so rows never slide out from under a hand on the wheel.
      if (!interacting || order.length !== tasks.length || order.some((t) => !tasks.includes(t))) {
        const prev = new Map(order.map((t, i) => [t.id, i]));
        order = tasks.slice().sort((a, b) => rank(a) - rank(b) || (prev.get(a.id) ?? 99) - (prev.get(b.id) ?? 99));
      } else {
        order = order.map((t) => tasks.find((x) => x.id === t.id) ?? t);
      }

      for (const [id, row] of rows) {
        if (!order.some((t) => t.id === id)) { row.el.remove(); rows.delete(id); }
      }
      for (const task of order) {
        let row = rows.get(task.id);
        if (!row) {
          row = makeRow(task);
          rows.set(task.id, row);
          row.el.classList.add("entering");
          wheel.append(row.el);
          const fresh = row.el;
          window.setTimeout(() => fresh.classList.remove("entering"), 450);
        }
        paint(row, task);
      }
      paintRail();

      // Anyone who needs the owner gravitates to the centre on their own; otherwise the wheel follows focus.
      const urgent = order.findIndex((t) => rank(t) <= 0);
      const focusAt = order.findIndex((t) => t.id === State.focusTask?.id);
      const want = !interacting && urgent >= 0 ? urgent : Math.max(0, focusAt);
      if (!dragging && Math.round(pos.target) !== want) {
        if (order[want] && order[want].id !== State.focusTask?.id) queueMicrotask(() => focusIndex(want));
        if (first) pos.set(want);
        else pos.target = want;
      }
      if (order.length) first = false;
      if (pos.value > maxIndex()) pos.target = maxIndex();
      layout();
      run();
    },
  };
}
