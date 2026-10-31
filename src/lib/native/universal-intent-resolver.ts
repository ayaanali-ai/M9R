/**
 * Small, provider-neutral intent contract for desktop work.
 *
 * This is planning only. It never launches an app or dispatches input. The
 * provider remains free to choose the next observe/action call, while the
 * contract makes the safe universal order explicit and preserves durable
 * no-submit/no-advance boundaries.
 */
export type IntentSurface = "browser" | "app" | "desktop" | "system" | "unknown";
export type IntentAction = "observe" | "open_app" | "navigate" | "click" | "type" | "select" | "scroll" | "drag" | "system_control" | "answer_in_place" | "unknown";
export type IntentMode = "explain" | "prepare" | "advance" | "submit";

export interface IntentObservationHint {
  targetKind?: "desktop" | "app-window" | "browser-tab";
  title?: string;
  url?: string;
  controls?: readonly { label?: string; role?: string; enabled?: boolean; actions?: readonly string[] }[];
}

export interface UniversalIntentStep {
  kind: "bind-foreground" | "browser-tab-select" | "observe-structure" | "observe-visual" | "launch-search" | "semantic-target" | "coordinate-fallback" | "reobserve" | "verify" | "ask";
  reason: string;
}

export interface UniversalIntentContract {
  version: "m9r.intent.v1";
  rawText: string;
  normalizedText: string;
  surface: IntentSurface;
  action: IntentAction;
  mode: IntentMode;
  constraints: { allowAdvance: boolean; allowSubmit: boolean };
  confidence: number;
  ambiguity: readonly string[];
  entities: {
    app?: string; query?: string; field?: string; value?: string; control?: string;
    systemControl?: "display_brightness" | "output_audio" | "media" | "microphone";
    systemAction?: "get" | "set" | "increase" | "decrease" | "mute" | "unmute" | "play_pause" | "next" | "previous";
  };
  preferredObservation: "desktop" | "app-window" | "browser-tab";
  plan: readonly UniversalIntentStep[];
  fallbackPolicy: {
    structureFirst: true;
    screenshotFallback: true;
    currentForegroundFirst: true;
    startSearchBeforeTaskbar: true;
    boundedReobserveAfterMutation: true;
    noImplicitForegroundTakeover: true;
  };
}

const BROWSER_WORDS = /\b(?:browser|chrome|edge|firefox|youtube|website|web\s*page|tab|url|site|google|github)\b/i;
const APP_WORDS = /\b(?:app|application|program|desktop|notepad|calculator|terminal|powershell|word|excel|powerpoint|claude|codex|opencode|open\s+code|chrome|edge|firefox|discord|spotify)\b/i;
const SYSTEM_WORDS = /\b(?:brightness|volume|audio|sound|speaker|microphone|mic|mute|unmute|media|play\s*pause|next\s+track|previous\s+track)\b/i;

function clean(value: string): string { return value.trim().replace(/\s+/g, " ").slice(0, 4_000); }
function firstMatch(value: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) { const match = value.match(pattern); if (match?.[1]) return clean(match[1]); }
  return undefined;
}

function inferSurface(text: string, hint?: IntentObservationHint): IntentSurface {
  if (hint?.targetKind === "browser-tab" || hint?.url || BROWSER_WORDS.test(text)) return "browser";
  if (hint?.targetKind === "app-window" || APP_WORDS.test(text)) return "app";
  if (SYSTEM_WORDS.test(text) && !/\b(?:dictation|voice\s+typing)\b/i.test(text)) return "system";
  if (hint?.targetKind === "desktop" || /\b(?:screen|desktop|taskbar|start\s+menu|computer)\b/i.test(text)) return "desktop";
  if (/\b(?:dictation|voice\s+typing)\b/i.test(text)) return "app";
  return "unknown";
}

function inferSystem(text: string): UniversalIntentContract["entities"] {
  const lower = text.toLowerCase();
  const systemControl = /\bbrightness\b/.test(lower) ? "display_brightness"
    : /\b(?:microphone|mic)\b/.test(lower) ? "microphone"
      : /\b(?:media|play\s*pause|next\s+track|previous\s+track)\b/.test(lower) ? "media"
        : /\b(?:volume|audio|sound|speaker)\b/.test(lower) ? "output_audio" : undefined;
  if (!systemControl) return {};
  const systemAction = /\b(?:increase|raise|turn\s+up|louder|up)\b/.test(lower) ? "increase"
    : /\b(?:decrease|lower|turn\s+down|quieter|down)\b/.test(lower) ? "decrease"
      : /\b(?:mute|silence)\b/.test(lower) ? "mute"
        : /\bunmute\b/.test(lower) ? "unmute"
          : /\b(?:set|change)\b/.test(lower) ? "set"
            : /\b(?:play|pause|play\s*pause)\b/.test(lower) ? "play_pause"
              : /\bnext\b/.test(lower) ? "next" : /\b(?:previous|back)\b/.test(lower) ? "previous" : "get";
  return { systemControl, systemAction };
}

function inferAction(text: string, surface: IntentSurface, system: UniversalIntentContract["entities"]): IntentAction {
  const lower = text.toLowerCase();
  if (system.systemControl) return "system_control";
  if (/\b(?:dictation|voice\s+typing)\b/.test(lower)) return "click";
  if (/\b(?:look|show|inspect|see|observe)\s+(?:at\s+)?(?:my\s+)?(?:screen|desktop|current\s+window)|\bwhat(?:'s| is)\s+on\s+my\s+screen\b|\bwhat\s+is\s+open\b/.test(lower)) return "observe";
  if (/\b(?:open|launch|start)\b/.test(lower) && !/\b(?:page|site|url|tab|youtube|github)\b/.test(lower)) return "open_app";
  if (/\b(?:go to|navigate|visit|open)\b.*\b(?:https?:\/\/|www\.|site|website|page|youtube|github)\b/.test(lower)) return "navigate";
  if (/\b(?:drag|move)\b/.test(lower)) return "drag";
  if (/\bscroll\b/.test(lower)) return "scroll";
  if (/\b(?:answer|respond to)\b/.test(lower)) return "answer_in_place";
  if (/\b(?:choose|select)\b/.test(lower)) return "select";
  if (/\b(?:type|enter|write|fill|input)\b/.test(lower)) return "type";
  if (/\b(?:click|press|toggle|expand|collapse|submit|check|uncheck)\b/.test(lower)) return "click";
  return surface === "unknown" ? "unknown" : "observe";
}

function inferMode(text: string, action: IntentAction): UniversalIntentContract["constraints"] & { mode: IntentMode } {
  const lower = text.toLowerCase();
  // Allow natural conjunctions such as "do not submit or advance" without
  // treating the second verb as a positive instruction. The bounded window
  // prevents a distant sentence from changing the current intent.
  const noAdvance = /\b(?:do\s+not|don't|dont|never|without)\b[^.!?]{0,48}\b(?:advance|continue|go\s+to\s+the\s+next|next\s+(?:question|item|page))\b/.test(lower);
  const noSubmit = /\b(?:do\s+not|don't|dont|never|without)\b[^.!?]{0,48}\b(?:submit|send|post|finish|publish)\b/.test(lower);
  const submit = /\b(?:submit|send|post|publish|finish(?:\s+and\s+submit)?)\b/.test(lower) && !noSubmit;
  const advance = /\b(?:advance|continue|next\s+(?:question|item|page)|go\s+to\s+the\s+next)\b/.test(lower) && !noAdvance;
  const explain = /\b(?:explain|what(?:'s|\s+is)|why|how\s+does|tell\s+me|answer\s+in\s+(?:chat|m9r))\b/.test(lower);
  const prepare = /\b(?:prepare|draft|fill|type|write|answer|complete)\b/.test(lower);
  const mode: IntentMode = submit ? "submit" : advance ? "advance" : action === "observe" && !submit && !advance ? "explain" : explain && !prepare ? "explain" : "prepare";
  return { mode, allowAdvance: advance || submit, allowSubmit: submit };
}

function planFor(surface: IntentSurface, action: IntentAction): UniversalIntentStep[] {
  const plan: UniversalIntentStep[] = [{ kind: "bind-foreground", reason: "Bind the actual current foreground surface; never reuse a remembered app target silently." }];
  if (surface === "browser") plan.push({ kind: "browser-tab-select", reason: "Select the exact existing tab by title or URL before navigating or interacting." });
  plan.push({ kind: "observe-structure", reason: "Read UI Automation or DOM structure before pixels." });
  if (action === "open_app") plan.push({ kind: "launch-search", reason: "Use Start/Search when direct launch cannot resolve the app; taskbar is a bounded fallback." });
  if (["click", "select", "type", "scroll", "drag", "answer_in_place"].includes(action)) {
    plan.push({ kind: "semantic-target", reason: "Rank enabled controls by role, label, state, and location." });
    plan.push({ kind: "reobserve", reason: "Reobserve after dropdown, popup, navigation, or virtualized-content mutation." });
    plan.push({ kind: "coordinate-fallback", reason: "Use bounded window-local pixels only when structure cannot answer." });
  }
  if (action === "unknown") plan.push({ kind: "ask", reason: "Ask one concise clarification rather than inventing a target." });
  else if (action !== "observe") plan.push({ kind: "verify", reason: "Verify the postcondition with fresh observable evidence." });
  return plan;
}

export function resolveUniversalIntent(rawText: string, hint?: IntentObservationHint): UniversalIntentContract {
  if (typeof rawText !== "string" || clean(rawText).length === 0) throw new Error("Intent text must contain at least one non-space character.");
  const normalizedText = clean(rawText);
  const surface = inferSurface(normalizedText, hint);
  const entities = { ...inferSystem(normalizedText),
    ...(firstMatch(normalizedText, [/\b(?:open|launch|start)\s+(.+?)(?:\s+(?:app|application|program))?(?:\s+and\b|\s+then\b|$)/i]) && surface === "app" ? { app: firstMatch(normalizedText, [/\b(?:open|launch|start)\s+(.+?)(?:\s+(?:app|application|program))?(?:\s+and\b|\s+then\b|$)/i]) } : {}),
    ...(firstMatch(normalizedText, [/\b(?:search|look\s+up|find)\s+(?:for\s+)?["“]?(.+?)["”]?(?:\s+on\s+|\s+in\s+|$)/i]) ? { query: firstMatch(normalizedText, [/\b(?:search|look\s+up|find)\s+(?:for\s+)?["“]?(.+?)["”]?(?:\s+on\s+|\s+in\s+|$)/i]) } : {}),
    ...(hint?.controls?.find((control) => control.enabled !== false && control.label && normalizedText.toLowerCase().includes(control.label.toLowerCase()))?.label ? { control: hint.controls.find((control) => control.enabled !== false && control.label && normalizedText.toLowerCase().includes(control.label.toLowerCase()))?.label } : {}),
    ...(/\b(?:dictation|voice\s+typing)\b/i.test(normalizedText) ? { control: "dictation" } : {}),
  };
  const action = inferAction(normalizedText, surface, entities);
  const mode = inferMode(normalizedText, action);
  const ambiguity: string[] = [];
  if (surface === "unknown") ambiguity.push("The surface is ambiguous; bind foreground and ask if multiple targets match.");
  if (action === "unknown") ambiguity.push("The requested operation is not a recognized safe computer action.");
  const preferredObservation = surface === "browser" ? "browser-tab" : surface === "app" ? "app-window" : "desktop";
  return {
    version: "m9r.intent.v1", rawText, normalizedText, surface, action, mode: mode.mode,
    constraints: { allowAdvance: mode.allowAdvance, allowSubmit: mode.allowSubmit },
    confidence: Math.max(0, Math.min(1, 0.45 + (surface !== "unknown" ? 0.2 : 0) + (action !== "unknown" ? 0.2 : 0) - ambiguity.length * 0.1)),
    ambiguity, entities, preferredObservation, plan: planFor(surface, action),
    fallbackPolicy: { structureFirst: true, screenshotFallback: true, currentForegroundFirst: true, startSearchBeforeTaskbar: true, boundedReobserveAfterMutation: true, noImplicitForegroundTakeover: true },
  };
}
