// Provider marks: the real Claude, Codex and OpenCode logos stand in for any character. A small status ring shows state.

import type { BotStateName } from "../core/layout";
import type { Provider } from "../core/state";
import { h } from "./dom";
// Imported (not referenced by path) so the files are bundled and resolved relative to wherever the bundle is loaded from.
import claudeLogo from "../assets/providers/claude.svg";
import codexLogo from "../assets/providers/codex.svg";
import opencodeLogo from "../assets/providers/opencode.svg";
import agentLogo from "../assets/providers/agent.svg";

const FILES: Record<Provider, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
  agent: agentLogo,
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
