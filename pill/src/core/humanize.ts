// Plain-language status for agents. Raw provider output (timeouts, protocol names, stack text) never reaches the owner.

import type { AgentRunState, AgentTask } from "./state";
import { botGlowColor } from "./layout";

export interface PlainStatus {
  label: string;
  color: string;
  /** Live states breathe; settled states hold still. */
  live: boolean;
}

const LABELS: Record<AgentRunState, string> = {
  idle: "Good to go",
  seen: "Good to go",
  starting: "Waking up",
  working: "Working",
  waiting: "Thinking",
  blocked: "Needs you",
  stopped: "Resting",
  failed: "Hit a snag",
  unknown: "Checking in",
  not_connected: "Offline",
};

export function plainStatus(task: AgentTask): PlainStatus {
  const label = task.state === "approval" ? "Needs you" : LABELS[task.runState] ?? "Good to go";
  const live = task.runState === "working" || task.runState === "starting" || task.runState === "waiting";
  const settled = task.runState === "idle" || task.runState === "seen" || task.runState === "stopped" || task.runState === "not_connected";
  return { label, color: settled ? "#8e939c" : botGlowColor(task.state), live };
}

const PRODUCT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

/** The provider's own product name, as the owner knows it; anything else gets its handle in title case ("gemini" → "Gemini"). */
export function displayName(task: Pick<AgentTask, "provider" | "name">): string {
  return PRODUCT_NAMES[task.provider] ?? task.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const RAW = /timeout|timed out|\d{3,}\s*ms|initiali[sz]e|app-server|\b(?:ACP|MCP|UIA|CDP|RPC)\b|ECONN|ENOENT|EPIPE|exit code|stack|exception|\bapi error\b|error:|\bat \w+\.|undefined|null|stderr|json|broker|dispatchState|targetRevision|screenPoint|renderer=|m9r_[\w-]+|foreground lease|input stream|operation id|task id|provider turn|sendTextToWindow|WM_CHAR|PostMessageW|SendInput/i;
const FIRST_PERSON = /^(?:i(?:['’]m| am| will|['’]ll| have|['’]ve)|we(?:['’]re| are| will|['’]ll| have)|let me)\s+/i;
const VERB_START: Readonly<Record<string, string>> = {
  check: "Checking",
  verify: "Checking",
  inspect: "Reviewing",
  review: "Reviewing",
  read: "Reading",
  look: "Looking",
  find: "Looking for",
  search: "Searching",
  open: "Opening",
  create: "Creating",
  write: "Writing",
  save: "Saving",
  calculate: "Calculating",
  compare: "Comparing",
  visit: "Opening",
  navigate: "Opening",
};
const MAX_PILL_STEP_CHARS = 84;

/** Keep short, readable progress; provider narration and tool traces resolve to the current plain status. */
export function plainStep(task: AgentTask, step: string | undefined): string {
  if (/[\r\n]/.test(step ?? "")) return fallback(task);
  const original = (step ?? "").replace(/\s+/g, " ").trim();
  if (!original || original === "…" || original.length > MAX_PILL_STEP_CHARS || RAW.test(original)) return fallback(task);

  let text = original
    .replace(/^[\s>*•`]+/, "")
    .replace(/^(?:(?:okay|all right|now),?\s+)/i, "")
    .replace(FIRST_PERSON, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!text || text.length > MAX_PILL_STEP_CHARS || RAW.test(text)) return fallback(task);
  text = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

  const match = /^(check|verify|inspect|review|read|look|find|search|open|create|write|save|calculate|compare|visit|navigate)\b/i.exec(text);
  if (!match) return text;
  const replacement = VERB_START[match[1]!.toLowerCase()];
  return replacement ? `${replacement}${text.slice(match[0].length)}` : text;
}

function fallback(task: AgentTask): string {
  if (task.state === "finished") return "Finished what you asked";
  if (task.state === "error") return "Couldn't finish that";
  if (task.state === "approval") return "Waiting on your OK";
  switch (task.runState) {
    case "failed": return "Couldn't finish starting";
    case "not_connected": return "Not connected on this device";
    case "working": return "On it";
    case "starting": return "Getting ready";
    case "waiting": return "Thinking it through";
    case "blocked": return "Waiting on your OK";
    case "stopped": return "Paused until you need it";
    default: return "Available";
  }
}
