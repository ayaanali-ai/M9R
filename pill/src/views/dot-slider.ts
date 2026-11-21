// Dot-stop slider: a full-width track filled up to the current stop, a dot mark at every stop, and a white thumb that
// snaps to the nearest stop on a damped spring (the same integrator the drum and island geometry use). Shared by every
// Settings card: 2 stops for on/off settings, 3 for the choice settings.

import { h } from "./dom";
import { Spring, clamp } from "../core/anim";

export interface DotSlider {
  el: HTMLElement;
  /** Reflect the current stop from State; animates unless it's the first sync. */
  sync(index: number): void;
}

/** `onPick` fires once per committed change (release or key), never mid-drag. */
export function dotSlider(labels: string[], ariaLabel: string, onPick: (index: number) => void): DotSlider {
  const n = labels.length;
  const max = n - 1;
  const pct = (p: number) => `${(clamp(p, -0.15, max + 0.15) / max) * 100}%`;

  const fill = h("div", { class: "dot-slider-fill" });
  const dots = labels.map((_, i) => {
    const d = h("span", { class: "dot-slider-dot" });
    d.style.left = pct(i);
    return d;
  });
  const thumb = h("div", { class: "dot-slider-thumb" });
  const track = h("div", { class: "dot-slider-track" }, fill, ...dots, thumb);
  const captions = labels.map((text, i) => {
    const c = h("span", { class: "dot-slider-caption", text });
    c.style.left = pct(i);
    if (i === 0) c.classList.add("first");
    if (i === max) c.classList.add("last");
    return c;
  });
  const el = h(
    "div",
    { class: "dot-slider", role: "slider", tabindex: "0", "aria-label": ariaLabel, "aria-valuemin": "0", "aria-valuemax": String(max) },
    track,
    h("div", { class: "dot-slider-captions" }, ...captions),
  );

  const pos = new Spring(0, 0.34, 0.68);
  let committed = -1;
  let first = true;
  let raf = 0;
  let lastFrame = 0;
  let drag: { left: number; width: number; startX: number; lastX: number; lastT: number; v: number; moved: boolean } | null = null;

  function render() {
    const p = pos.value;
    fill.style.width = pct(Math.max(0, p));
    thumb.style.left = pct(p);
    const at = clamp(Math.round(p), 0, max);
    dots.forEach((d, i) => d.classList.toggle("passed", i <= p + 0.01));
    captions.forEach((c, i) => c.classList.toggle("on", i === at));
    el.setAttribute("aria-valuenow", String(at));
    el.setAttribute("aria-valuetext", labels[at]);
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
    if (!drag) {
      pos.step(dt);
      if (pos.settled) pos.set(pos.target);
    }
    render();
    if (drag || !pos.settled) run();
  }

  function commit(index: number, velocity = 0) {
    const i = clamp(Math.round(index), 0, max);
    pos.target = i;
    pos.velocity = velocity;
    run();
    if (i !== committed) {
      committed = i;
      onPick(i);
    }
  }

  const stopAt = (clientX: number) => drag ? ((clientX - drag.left) / Math.max(1, drag.width)) * max : 0;

  el.addEventListener("pointerdown", (e) => {
    // The slider owns its own gesture; the settings wheel behind it must not start a spin.
    e.stopPropagation();
    const r = track.getBoundingClientRect();
    drag = { left: r.left, width: r.width, startX: e.clientX, lastX: e.clientX, lastT: e.timeStamp, v: 0, moved: false };
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    // A press without movement is a jump to the nearest stop on release; any movement follows the finger.
    run();
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
    if (!drag.moved) return;
    const raw = stopAt(e.clientX);
    // Soft resistance past either end, as on the drum.
    pos.value = raw < 0 ? -0.15 * (1 - 1 / (-raw * 2 + 1)) : raw > max ? max + 0.15 * (1 - 1 / ((raw - max) * 2 + 1)) : raw;
    const dtMs = Math.max(1, e.timeStamp - drag.lastT);
    const inst = (((e.clientX - drag.lastX) / Math.max(1, drag.width)) * max) / (dtMs / 1000);
    drag.v = drag.v * 0.6 + inst * 0.4;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
  });
  const release = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    const target = d.moved ? pos.value : stopAt(e.clientX);
    drag = null;
    // A quick flick carries a little past where the finger let go, then the spring settles on the stop.
    commit(d.moved ? target + d.v * 0.06 : target, d.moved ? d.v : 0);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", (e) => release(e));
  el.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    commit(Math.round(pos.target) + step);
  });

  render();

  return {
    el,
    sync(index) {
      const i = clamp(index, 0, max);
      committed = i;
      if (drag) return;
      if (first) {
        first = false;
        pos.set(i);
        render();
        return;
      }
      if (pos.target !== i) {
        pos.target = i;
        run();
      }
    },
  };
}
