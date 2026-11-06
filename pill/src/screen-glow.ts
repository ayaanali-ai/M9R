import "./screen-glow.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ScreenGlowState {
  revision: number;
  visible: boolean;
  style: "status" | "rainbow";
  color: string;
  live: boolean;
}

const root = document.getElementById("screen-glow");
let appliedRevision = -1;

function apply(state: ScreenGlowState): void {
  if (!root || !Number.isSafeInteger(state.revision) || state.revision < appliedRevision) return;
  appliedRevision = state.revision;
  root.classList.toggle("visible", state.visible);
  root.classList.toggle("rainbow", state.style === "rainbow");
  root.classList.toggle("live", state.live);
  if (/^#[\da-fA-F]{6}$/.test(state.color)) root.style.setProperty("--glow-color", state.color);
}

async function start(): Promise<void> {
  try {
    await listen<ScreenGlowState>("screen-glow-update", ({ payload }) => apply(payload));
    apply(await invoke<ScreenGlowState>("read_screen_glow"));
  } catch {
    // A failed presentation window stays transparent and cannot affect input or the pill.
  }
}

void start();
