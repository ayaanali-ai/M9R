// Settings wheel: the six Settings cards on one vertical drum, the same anatomy and physics as the agent drum (drum.ts):
// the centred card is full size and the only interactive one; neighbours shrink, fade and curve away on a cylinder.
// Release physics use Apple's projection and rubber-band functions, settled by a damped spring. No wraparound: past the
// first or last card the wheel rubber-bands and springs back.

import { h } from "./dom";
import { Spring, clamp } from "../core/anim";

/** Vertical drag travel, in px, that moves the wheel by one card. */
const ROW_PX = 64;
/** UIScrollView.DecelerationRate.normal. */
const DECEL = 0.998;

// Card placement by signed distance from centre: y offset (px), scale, opacity, tilt. Card-sized magnitudes of drum.ts.
const STOPS = [
  { d: 0, y: 0, s: 1, o: 1, r: 0 },
  { d: 1, y: 74, s: 0.82, o: 0.42, r: 20 },
  { d: 2, y: 100, s: 0.66, o: 0.1, r: 36 },
  { d: 2.6, y: 108, s: 0.58, o: 0, r: 46 },
];
const STOPS_UP = STOPS.map((s) => ({ ...s, y: -s.y }));

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

/** Where a flick comes to rest, per UIScrollView deceleration. Velocity in cards/s. */
function project(velocity: number): number {
  return ((velocity / 1000) * DECEL) / (1 - DECEL);
}

export interface SettingsDrum {
  el: HTMLElement;
}

/** `cards` are placed in the given, fixed order; `onDetent` fires each time a new card reaches the centre. */
export function buildSettingsDrum(cards: HTMLElement[], onDetent: () => void): SettingsDrum {
  const wheel = h("div", { class: "sdrum-wheel" }, ...cards);
  const el = h("div", { class: "sdrum", tabindex: "0", "aria-roledescription": "settings wheel" }, wheel);
  cards.forEach((c) => c.classList.add("sdrum-card"));

  const max = cards.length - 1;
  const pos = new Spring(0, 0.42, 0.86);
  let dragging: { startY: number; startPos: number; lastY: number; lastT: number; v: number } | null = null;
  let moved = false;
  let lastDetent = 0;
  let raf = 0;
  let lastFrame = 0;
  let wheelTimer = 0;

  function snapTo(index: number, velocity = 0) {
    pos.target = clamp(Math.round(index), 0, max);
    pos.velocity = velocity;
    run();
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
    const detent = clamp(Math.round(pos.value), 0, max);
    if (detent !== lastDetent) {
      lastDetent = detent;
      onDetent();
    }
    if (dragging || !pos.settled) run();
  }

  function layout() {
    const p = pos.value;
    cards.forEach((card, i) => {
      const dist = i - p;
      const hidden = Math.abs(dist) > 2.6;
      card.style.visibility = hidden ? "hidden" : "visible";
      const centre = Math.abs(dist) < 0.5;
      card.classList.toggle("centre", centre);
      // Only the centred card takes input; the rest are scenery.
      card.inert = !centre;
      card.setAttribute("aria-hidden", String(!centre));
      if (hidden) return;
      const k = sample(dist);
      card.style.transform = `translate3d(0, ${k.y}px, 0) rotateX(${-k.r}deg) scale(${k.s})`;
      card.style.opacity = String(k.o);
      card.style.zIndex = String(10 - Math.round(Math.abs(dist) * 2));
    });
  }

  // ── Input: drag, wheel, keys (as drum.ts) ─────────────────────────

  el.addEventListener("pointerdown", (e) => {
    // Buttons on the centred card keep their own clicks; the slider stops its own pointerdown.
    if ((e.target as HTMLElement).closest("button")) return;
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
    if (!moved) return snapTo(pos.value);
    snapTo(pos.value + project(v), v);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
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
    snapTo(Math.round(pos.target) + (e.key === "ArrowDown" ? 1 : -1));
  });

  layout();
  return { el };
}
