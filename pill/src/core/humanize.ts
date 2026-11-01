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

const RAW = /timeout|timed out|\d{3,}\s*ms|initiali[sz]e|app-server|\bACP\b|ECONN|ENOENT|EPIPE|exit code|stack|exception|error:|\bat \w+\.|undefined|null|stderr|rpc|json/i;

/** One line of activity, safe to show: raw technical text is replaced by plain words for the state. */
export function plainStep(task: AgentTask, step: string | undefined): string {
  const text = (step ?? "").trim();
  if (!text || text === "…") return fallback(task);
  if (RAW.test(text)) return fallback(task);
  return text;
}

function fallback(task: AgentTask): string {
  switch (task.runState) {
    case "failed": return "Couldn't finish starting up";
    case "not_connected": return "Not connected on this device";
    case "working": return "On it";
    case "starting": return "Getting ready";
    case "waiting": return "Thinking it through";
    case "blocked": return "Waiting on your OK";
    case "stopped": return "Paused until you need it";
    default: return "Ready when you are";
  }
}
