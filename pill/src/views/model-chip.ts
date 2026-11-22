// The composer's own model/effort picker: a small chip (provider logo + model name + effort),
// opening a popover above the composer with a plain model list and a "molten fill" effort slider
// -- a thick track whose fill heats up from cool blue (Light) to white-hot (Max) as you drag.
// Built off the owner's ModelSelectorPrompt data (State.models); this chip shows only the
// currently-focused agent, not the whole roster. Replaces the old standalone Apps/model-picker page.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type PillModelAgent } from "../core/state";
import { providerLogo } from "./provider";
import { pickerProvider, PROVIDER_NAMES, effortLabel } from "./views";
import type { ViewActions } from "./views";

export interface ModelChipHost {
  el: HTMLElement;
  sync(): void;
}

/** Short trigger text: "GPT-5.2" not "GPT-5.2 Thinking (extra high effort)". */
function shortLabel(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15)}…` : label;
}

/** 0..1 across the effort list, for the molten-fill color/position. */
function effortRatio(efforts: { id: string }[], effortId: string | null): number {
  if (!efforts.length) return 0;
  const i = Math.max(0, efforts.findIndex((e) => e.id === effortId));
  return efforts.length <= 1 ? 1 : i / (efforts.length - 1);
}

/** Cool blue-white at 0, amber at mid, white-hot at 1 -- the molten-fill gradient stop. */
function moltenColor(ratio: number): string {
  const stops: [number, number, number][] = [
    [120, 170, 255], // Light: cool blue-white
    [255, 255, 255], // Medium: white
    [255, 170, 60], // High: amber
    [255, 90, 40], // Max: hot orange
  ];
  const n = stops.length - 1;
  const pos = ratio * n;
  const lo = Math.floor(pos);
  const hi = Math.min(n, lo + 1);
  const t = pos - lo;
  const [r1, g1, b1] = stops[lo];
  const [r2, g2, b2] = stops[hi];
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

export function buildModelChip(actions: ViewActions): ModelChipHost {
  const trigger = h("button", { class: "model-chip", type: "button", title: "Model and reasoning effort" });
  const triggerLogo = h("span", { class: "mc-trigger-logo" });
  const triggerText = h("span", { class: "mc-trigger-text" });
  const triggerEffort = h("span", { class: "mc-trigger-effort" });
  trigger.append(triggerLogo, triggerText, triggerEffort, svg(ICONS.chevronDown, 11));

  const list = h("div", { class: "mc-list", role: "listbox", "aria-label": "Models" });
  const sliderTrack = h("div", { class: "mc-slider-track" });
  const sliderFill = h("div", { class: "mc-slider-fill" });
  const sliderHandle = h("div", { class: "mc-slider-handle" });
  sliderTrack.append(sliderFill, sliderHandle);
  const sliderLabel = h("div", { class: "mc-slider-label" });
  const sliderWrap = h("div", { class: "mc-slider-wrap" }, sliderLabel, sliderTrack);
  const pop = h("div", { class: "model-chip-pop" }, list, sliderWrap);
  const el = h("div", { class: "model-chip-root" }, trigger, pop);

  let open = false;
  let previewEffortIdx: number | null = null; // live while dragging, before the pointer is released
  let key = "";

  function agent(): PillModelAgent | undefined {
    const handle = State.focusTask?.name;
    return State.models?.agents.find((a) => a.handle === handle);
  }

  function currentModelId(a: PillModelAgent): string {
    return a.selectedModel ?? a.currentModel ?? a.models[0]?.id ?? "";
  }
  function currentEffortId(a: PillModelAgent): string | null {
    return a.selectedEffort ?? a.currentEffort ?? null;
  }

  function setOpen(next: boolean) {
    open = next;
    pop.classList.toggle("on", open);
    trigger.classList.toggle("on", open);
    if (open) { previewEffortIdx = null; renderList(); renderSlider(); }
  }

  trigger.addEventListener("click", () => setOpen(!open));
  document.addEventListener("pointerdown", (e) => {
    if (open && !el.contains(e.target as Node)) setOpen(false);
  });

  function renderList() {
    clear(list);
    const a = agent();
    if (!a || a.availability !== "available" || !a.models.length) {
      list.append(h("div", { class: "mc-empty", text: a ? "No model catalog yet." : "No connected agent." }));
      return;
    }
    const current = currentModelId(a);
    for (const model of a.models) {
      const on = model.id === current;
      const row = h("button", {
        class: "mc-row" + (on ? " on" : ""), role: "option", "aria-selected": on ? "true" : "false", type: "button",
        onclick: () => { if (!on) void pick(a, model.id, null); },
      },
        h("span", { class: "mc-row-text" },
          h("span", { class: "mc-row-label", text: model.label }),
          h("span", { class: "mc-row-provider", text: PROVIDER_NAMES[pickerProvider(a.provider)] })),
        on ? svg(ICONS.check, 12) : null,
      );
      list.append(row);
    }
  }

  function activeModel(a: PillModelAgent) {
    return a.models.find((m) => m.id === currentModelId(a));
  }

  function renderSlider() {
    const a = agent();
    const model = a && activeModel(a);
    const efforts = model?.efforts ?? null;
    sliderWrap.hidden = !a || !efforts || efforts.length === 0;
    if (!a || !efforts || !efforts.length) return;
    const idx = previewEffortIdx ?? Math.max(0, efforts.findIndex((e) => e.id === currentEffortId(a)));
    const ratio = effortRatio(efforts, efforts[idx]?.id ?? null);
    const color = moltenColor(ratio);
    sliderFill.style.width = `${ratio * 100}%`;
    sliderFill.style.background = `linear-gradient(90deg, ${moltenColor(0)}, ${color})`;
    sliderFill.style.boxShadow = idx === efforts.length - 1 ? `0 0 14px 2px ${color}` : `0 0 6px 0 ${color}`;
    sliderHandle.style.left = `${ratio * 100}%`;
    sliderHandle.style.background = color;
    sliderLabel.textContent = effortLabel(efforts[idx]?.label ?? "");
    sliderTrack.dataset.stops = String(efforts.length);
  }

  function stopIndexFromX(a: PillModelAgent, clientX: number): number {
    const model = activeModel(a);
    const efforts = model?.efforts ?? [];
    const rect = sliderTrack.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(t * (efforts.length - 1));
  }

  async function pick(a: PillModelAgent, modelId: string, effortId: string | null) {
    if (!actions.selectModel) return;
    try {
      await actions.selectModel(a.handle, modelId, effortId);
    } catch { /* the trigger just keeps showing the last-known state */ }
    key = "";
    sync();
  }

  let dragging = false;
  sliderTrack.addEventListener("pointerdown", (e) => {
    const a = agent();
    if (!a) return;
    dragging = true;
    sliderTrack.setPointerCapture(e.pointerId);
    previewEffortIdx = stopIndexFromX(a, e.clientX);
    renderSlider();
  });
  sliderTrack.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const a = agent();
    if (!a) return;
    previewEffortIdx = stopIndexFromX(a, e.clientX);
    renderSlider();
  });
  sliderTrack.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    const a = agent();
    const model = a && activeModel(a);
    const efforts = model?.efforts ?? [];
    const idx = previewEffortIdx ?? stopIndexFromX(a!, e.clientX);
    previewEffortIdx = null;
    if (a && model && efforts[idx]) void pick(a, model.id, efforts[idx].id);
  });

  function sync() {
    const a = agent();
    const next = JSON.stringify(a ? [a.handle, a.provider, a.currentModel, a.currentEffort, a.selectedModel, a.selectedEffort, a.models] : null);
    if (next === key) return;
    key = next;
    if (!a || a.availability !== "available" || !a.models.length) {
      trigger.hidden = true;
      if (open) setOpen(false);
      return;
    }
    trigger.hidden = false;
    triggerLogo.replaceChildren(providerLogo(pickerProvider(a.provider), 13));
    const model = activeModel(a);
    triggerText.textContent = model ? shortLabel(model.label) : "";
    const effort = currentEffortId(a);
    const effortTag = model?.efforts?.find((e) => e.id === effort)?.label;
    triggerEffort.textContent = effortTag ? effortLabel(effortTag).slice(0, 1).toUpperCase() : "";
    triggerEffort.hidden = !effortTag;
    if (open) { renderList(); renderSlider(); }
  }

  sync();
  return { el, sync };
}
