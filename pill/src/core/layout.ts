// Island geometry: window panel, mode sizes, per-view heights and where the focused agent's mark sits.
// All values are logical pixels.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "error"
  | "finished"
  | "prompt"
  | "models"
  | "note"
  | "settings"
  | "drop";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "unknown";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 720×320 (largest view); the island is
// drawn inside it, glued to the top edge and horizontally centred.
export const PANEL_W = 720;
export const PANEL_H = 320;

// No notch on a PC: these are the hidden and compact sizes.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  // Taller than the other views: the wheel needs room for two rows either side of the centred one.
  overview: { height: 196, botX: 68, botY: 114, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  // Same mark position as the drum so an approval reads as the wheel's centred agent asking, not a new screen.
  approval: { height: 160, botX: 68, botY: 96, botDiameter: 58, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  // Grows downward: the band leads with what finished, the steps unfold beneath it.
  finished: { height: 232, botX: 68, botY: 79, botDiameter: 52, agentMode: "column" },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  models: { height: 300, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 220, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  drop: { height: 200, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
};

/** One line when there's nothing to read yet; grows with the conversation and the draft. */
export function chatPromptHeight(messageCount: number, draftHeight = 20): number {
  const extra = Math.max(0, Math.min(200, draftHeight) - 20);
  if (messageCount === 0) return 108 + extra;
  return Math.min(300, 132 + messageCount * 34 + extra);
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  draftHeight = 20,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      const h = view === "prompt" ? chatPromptHeight(chatCount, draftHeight) : VIEW_LAYOUTS[view].height;
      return { w: EXPANDED_W, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** Where the focused agent's mark sits; cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      // Collapsed means solid black, nothing overlaid — no status mark, no provider logo.
      return { cx: 40, cy: 16, diameter: 20, opacity: 0 };
    case "expanded": {
      if (view === "models" || view === "prompt" || view === "drop") return { cx: 54, cy: 100, diameter: 46, opacity: 0 };
      const layout = VIEW_LAYOUTS[view];
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    case "unknown":
      return "#9AA1AC";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
    case "unknown":
      return 0.15;
    default:
      return 0.65;
  }
}

// Card wash colours
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
