// Provider marks: the real Claude, Codex and OpenCode logos stand in for any character. A small status ring shows state.

import type { BotStateName } from "../core/layout";
import type { Provider } from "../core/state";
import { h } from "./dom";

const FILES: Record<Provider, string> = {
  claude: "providers/claude.svg",
  codex: "providers/codex.svg",
  opencode: "providers/opencode.svg",
  agent: "providers/agent.svg",
};

/** `size` in pixels, or "fill" to take the size of the container. */
export function providerLogo(provider: Provider, size: number | "fill", state?: BotStateName): HTMLElement {
  const img = h("img", { src: FILES[provider] ?? FILES.agent, alt: provider, draggable: false });
  img.style.width = size === "fill" ? "100%" : `${size}px`;
  img.style.height = size === "fill" ? "100%" : `${size}px`;
  const wrap = h("span", { class: `logo ${size === "fill" ? "fill" : ""}` }, img);
  if (state) wrap.dataset.state = state;
  return wrap;
}
