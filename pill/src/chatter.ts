import "./chatter.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { providerLogo } from "./views/provider";
import type { Provider } from "./core/state";

/** One agent-to-agent chatter line, already accepted and bounded by sayAgentCursor
 * before it ever reaches this window -- this view only ever presents it. */
interface ChatterState {
  revision: number;
  visible: boolean;
  provider: Provider;
  text: string;
  x: number;
  y: number;
}

const root = document.getElementById("chatter-root");
let appliedRevision = -1;
let bubble: HTMLElement | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function ensureBubble(): HTMLElement {
  if (bubble) return bubble;
  const logo = document.createElement("span");
  logo.className = "logo";
  const line = document.createElement("span");
  line.className = "line";
  const el = document.createElement("div");
  el.className = "chatter-bubble";
  el.append(logo, line);
  root?.append(el);
  bubble = el;
  return el;
}

/** Holds ~3s once shown, same cadence as the locked design note, then fades
 * on its own -- the caller only ever has to say "show this", never "hide it". */
const HOLD_MS = 3000;

function apply(state: ChatterState): void {
  if (!root || !Number.isSafeInteger(state.revision) || state.revision < appliedRevision) return;
  appliedRevision = state.revision;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
  const el = ensureBubble();
  if (!state.visible) { el.classList.remove("visible"); return; }
  el.style.setProperty("--bx", `${state.x}px`);
  el.style.setProperty("--by", `${state.y}px`);
  const logo = el.querySelector(".logo");
  const mark = providerLogo(state.provider, 12).querySelector("img");
  if (logo && mark) logo.replaceChildren(mark);
  const line = el.querySelector(".line");
  if (line) line.textContent = state.text.slice(0, 160);
  // Reflow before adding .visible so the fade-in transition actually runs
  // even when the bubble was already in the DOM from a prior message.
  el.classList.remove("visible");
  void el.offsetWidth;
  el.classList.add("visible");
  hideTimer = setTimeout(() => el.classList.remove("visible"), HOLD_MS);
}

async function start(): Promise<void> {
  try {
    await listen<ChatterState>("chatter-update", ({ payload }) => apply(payload));
    apply(await invoke<ChatterState>("read_chatter"));
  } catch {
    // A failed presentation window stays empty and cannot affect A2A delivery.
  }
}

void start();
