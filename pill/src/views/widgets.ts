// Contextual widgets beside the drum. Each exists only while it has real data: limit dials once the centred agent's
// provider has reported its plan limits, the music card only while something is playing. Nothing is estimated.

import { h } from "./dom";
import { providerLogo } from "./provider";
import { State, type AgentTask, type PillMedia, type PillUsageWindow } from "../core/state";
import { MEDIA_TONE } from "../core/layout";
import { displayName } from "../core/humanize";

const R = 15;
const C = 2 * Math.PI * R;

function tone(left: number): string {
  if (left > 40) return "#34D399";
  if (left > 15) return "#F5A524";
  return "#F4505E";
}

function resetText(iso?: string): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
  if (mins < 60) return `Resets in ${mins}m`;
  if (mins < 24 * 60) return `Resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `Resets ${new Date(at).toLocaleDateString([], { weekday: "short" })}`;
}

function dial(label: string, win: PillUsageWindow): HTMLElement {
  const left = Math.max(0, Math.min(100, Math.round(100 - win.usedPercent)));
  const ns = "http://www.w3.org/2000/svg";
  const svgEl = document.createElementNS(ns, "svg");
  svgEl.setAttribute("viewBox", "0 0 40 40");
  svgEl.setAttribute("class", "dial-ring");
  const track = document.createElementNS(ns, "circle");
  const fill = document.createElementNS(ns, "circle");
  for (const c of [track, fill]) {
    c.setAttribute("cx", "20");
    c.setAttribute("cy", "20");
    c.setAttribute("r", String(R));
  }
  track.setAttribute("class", "dial-track");
  fill.setAttribute("class", "dial-fill");
  fill.style.strokeDasharray = `${C}`;
  fill.style.setProperty("--to", String(C * (1 - left / 100)));
  fill.style.stroke = tone(left);
  svgEl.append(track, fill);
  const reset = resetText(win.resetsAt);
  return h("div", { class: "dial", title: reset ? `${left}% left · ${reset}` : `${left}% left` },
    h("div", { class: "dial-face" }, svgEl, h("span", { class: "dial-num", text: `${left}` })),
    h("span", { class: "dial-label", text: label }),
  );
}

function limits(task: AgentTask): HTMLElement | null {
  const u = State.usage.find((x) => x.handle === task.name);
  if (!u || (!u.fiveHour && !u.weekly)) return null;
  return h("div", { class: "widget limits" },
    h("div", { class: "widget-head" }, providerLogo(task.provider, 10), h("span", { text: `${displayName(task)} left` })),
    h("div", { class: "dials" }, u.fiveHour ? dial("5-hour", u.fiveHour) : null, u.weekly ? dial("Weekly", u.weekly) : null),
  );
}

function music(m: PillMedia): HTMLElement {
  const bars = h("span", { class: "eq" + (m.playing ? " on" : "") }, h("i"), h("i"), h("i"));
  const art = h("span", { class: "art" }, bars);
  art.style.setProperty("--tone", MEDIA_TONE[m.source]);
  return h("div", { class: "widget music", title: m.artist ? `${m.title} · ${m.artist}` : m.title },
    art,
    h("span", { class: "music-text" },
      h("span", { class: "music-title", text: m.title }),
      m.artist ? h("span", { class: "music-artist", text: m.artist }) : null,
    ),
  );
}

export interface Widgets {
  el: HTMLElement;
  /** Re-reads State; returns whether there is anything to show. */
  sync(): boolean;
}

export function buildWidgets(): Widgets {
  const el = h("div", { class: "widgets", "aria-label": "Now" });
  let key = "";
  return {
    el,
    sync() {
      const task = State.focusTask;
      const u = task ? State.usage.find((x) => x.handle === task.name) : undefined;
      const m = State.media?.playing ? State.media : null;
      const next = JSON.stringify([task?.id, u, m]);
      if (next !== key) {
        key = next;
        el.replaceChildren(...[m ? music(m) : null, task ? limits(task) : null].filter((x): x is HTMLElement => !!x));
      }
      return el.childElementCount > 0;
    },
  };
}
