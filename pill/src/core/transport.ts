// The pill talks to its host only through this interface. The desktop shell and the browser shell each provide an adapter;
// in a plain browser tab (npm run dev) the mock below stands in so the UI can be developed and inspected alone.

import type { DroppedFile, LinkOffer, PillSnapshot, Settings } from "./state";
import type { SpeechEnv } from "./speech";
import { agentAck } from "./humanize";

export type Decision = "allow" | "deny" | "allow_day";

export interface SessionRow {
  sessionId: string;
  cwd?: string;
  lastSeenAt: string;
}

/** Points are CSS pixels relative to the pill's window. */
export interface FileDropHandlers {
  over(x: number, y: number): void;
  leave(): void;
  drop(files: DroppedFile[], x: number, y: number): void;
}

export interface PillTransport {
  setOwnerWorkMode?(mode: "working" | "agents-free"): Promise<void>;
  /** What this host can actually do; the UI hides controls a host cannot honour instead of faking them. */
  capabilities?: { allowForADay?: boolean; linkSessions?: boolean; dictation?: boolean; saveMemory?: boolean; dismissTask?: boolean };
  /** Opens the one-time microphone setup. Only with `capabilities.dictation`. */
  openMicSetup?(): void;
  /** Creates a shell-specific speech environment when browser permission behavior differs by host. */
  createDictationEnvironment?(): SpeechEnv;
  /** Sessions the engine knows for one agent, for the link picker. Only with `capabilities.linkSessions`. */
  listSessions?(handle: string): Promise<SessionRow[]>;
  /** Always route future messages from `offer.from` to this session of `offer.to`. Rejects with a sentence the owner can read. */
  linkSession?(offer: LinkOffer, toSession: string): Promise<void>;
  /** Starts delivering snapshots. The first call should arrive promptly with the current state. */
  subscribe(listener: (snapshot: PillSnapshot) => void): void | (() => void);
  /** Owner typed a message; `@handle` mentions inside it address agents. */
  /** May resolve to a short confirmation to show in the thread. Rejects with a sentence the owner can read. */
  send(text: string): Promise<string | void>;
  decide(approvalId: string, decision: Decision): Promise<void>;
  /** Saves a reply to the team's shared memory. Only with `capabilities.saveMemory`. */
  saveMemory?(text: string): Promise<void>;
  /** Dismisses a surfaced feed notice while preserving its task and delivery record. */
  dismissTask?(taskId: string): Promise<void>;
  /** Selects a live provider-reported model; the owner broker validates it. */
  selectModel?(handle: string, model: string | null, effort: string | null): Promise<void>;
  /** Native file drops with real paths (the desktop shell). Without it the pill falls back to the page's own drop events. */
  onFileDrop?(handlers: FileDropHandlers): void;
  /** Window-level hooks; no-ops in the browser shell. */
  setIslandRect?(x: number, y: number, width: number, height: number): void;
  setCollapsed?(collapsed: boolean): void;
  /** Mirrors the pill's current edge-light state onto the desktop's click-through screen frame. */
  setScreenGlow?(glow: { visible: boolean; style: "status" | "rainbow"; color: string; live: boolean }): void;
  /** The other pill is showing; hide this one (browser shell). Called only when the answer changes. */
  setSuppressed?(suppressed: boolean): void;
  focusWindow?(focused: boolean): void;
  saveSettings?(settings: Settings): void;
  /** Reads back the last saved settings, if the host can persist them. Called once at boot. */
  loadSettings?(): Promise<Partial<Settings> | void>;
}

declare global {
  interface Window {
    /** Set by a shell before the bundle loads. */
    __M9R_PILL_TRANSPORT__?: PillTransport;
  }
}

export const IN_HOST = typeof window !== "undefined" && window.__M9R_PILL_TRANSPORT__ !== undefined;

const SAMPLE: PillSnapshot = {
  agents: [
    { handle: "claude", provider: "claude", state: "working", activity: ["Opened the shared tab", "Reading the pricing table", "Comparing plans for the summary"] },
    { handle: "codex", provider: "codex", state: "idle", activity: ["Finished the broker fix"] },
    { handle: "opencode", provider: "opencode", state: "waiting", activity: ["Waiting for Claude Code's answer"] },
  ],
  approvals: [],
  thread: [],
  // Developer sample shaped like the real catalogs Claude Code and Codex report; never used by a real host.
  models: { agents: [
    { handle: "claude", provider: "claude-code", availability: "available", status: "ready", currentModel: "default", currentEffort: "high", models: [
      { id: "default", label: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] },
      { id: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable for your hardest and longest-running tasks", efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] },
      { id: "opus", label: "Opus 5.5", description: "Best for everyday, complex tasks", efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] },
      { id: "sonnet", label: "Sonnet 5", description: "Efficient for routine tasks", efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }] },
      { id: "haiku", label: "Haiku 4.5", description: "Fastest for quick answers", efforts: null },
    ] },
    { handle: "codex", provider: "codex", availability: "available", status: "ready", currentModel: "gpt-5.6-luna", currentEffort: "low", models: [
      { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: [{ id: "low", label: "low" }, { id: "medium", label: "medium" }, { id: "high", label: "high" }] },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: [{ id: "low", label: "low" }, { id: "medium", label: "medium" }, { id: "high", label: "high" }] },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: [{ id: "low", label: "low" }, { id: "medium", label: "medium" }] },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: [{ id: "low", label: "low" }, { id: "medium", label: "medium" }] },
    ] },
    { handle: "opencode", provider: "opencode", availability: "catalog_unavailable", status: "ready", currentModel: null, currentEffort: null, models: [] },
  ] },
};

/** Developer mock: a few agents, an approval that appears after a while, and echoed replies. */
export function createMockTransport(): PillTransport {
  let listener: ((s: PillSnapshot) => void) | null = null;
  const snap: PillSnapshot = structuredClone(SAMPLE);
  const push = () => listener?.(structuredClone(snap));
  const params = new URLSearchParams(location.search);
  if (params.has("failed")) {
    const codex = snap.agents.find((a) => a.handle === "codex");
    if (codex) { codex.state = "failed"; codex.activity.push("codex: initialize: no response within 180000ms"); }
  }
  // Sample provider limits and a playing track, to see the widgets. Real hosts send these only when providers/the OS report them.
  if (params.has("widgets")) {
    snap.usage = [
      { handle: "claude", fiveHour: { usedPercent: 38, resetsAt: new Date(Date.now() + 2.4 * 3600_000).toISOString() }, weekly: { usedPercent: 71, resetsAt: new Date(Date.now() + 3.2 * 86400_000).toISOString() } },
      { handle: "codex", fiveHour: { usedPercent: 88, resetsAt: new Date(Date.now() + 0.7 * 3600_000).toISOString() }, weekly: { usedPercent: 46 } },
    ];
    const source = params.get("widgets") === "apple" ? "apple-music" : "spotify";
    snap.media = { title: "Pink + White", artist: "Frank Ocean", source, playing: true };
  }
  // Claude Code finishes its task a moment after load, to show the task card.
  if (params.has("finish")) {
    setTimeout(() => {
      const claude = snap.agents.find((a) => a.handle === "claude");
      if (claude) { claude.state = "idle"; claude.task = "Compared the three pricing plans"; claude.activity.push("Wrote the summary to pricing.md"); }
      push();
    }, 2500);
  }
  if (params.has("approval")) {
    snap.approvals.push({ id: "a1", agent: "codex", title: "Post to the page", detail: "Click “Post” on x.com/compose" });
  } else if (!params.has("calm")) {
    setTimeout(() => {
      snap.approvals.push({ id: "a1", agent: "codex", title: "Post to the page", detail: "Click “Post” on x.com/compose" });
      push();
    }, 9000);
  }
  return {
    capabilities: { allowForADay: true },
    subscribe(l) { listener = l; setTimeout(push, 0); },
    async send(text) {
      const target = /@(\w+)/.exec(text)?.[1] ?? "claude";
      snap.thread.push({ id: `t${snap.thread.length + 1}`, from: target, text: agentAck() });
      const agent = snap.agents.find((a) => a.handle === target);
      if (agent) { agent.state = "working"; agent.activity.push("Working on your message"); }
      push();
    },
    async decide(id) {
      snap.approvals = snap.approvals.filter((a) => a.id !== id);
      push();
    },
    async selectModel(handle, model, effort) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const agent = snap.models?.agents.find((a) => a.handle === handle);
      if (agent) { agent.selectedModel = model; agent.selectedEffort = effort; }
      push();
    },
  };
}

export function getTransport(): PillTransport {
  return window.__M9R_PILL_TRANSPORT__ ?? createMockTransport();
}
