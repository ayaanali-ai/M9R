// Pill state. One shape for both shells: the desktop window and the in-page frame each hand the pill a PillSnapshot
// (agents, approvals, thread) and receive owner commands back through the transport. Nothing here knows about Tauri or Chrome.

import type { BotStateName, IslandMode, IslandViewName } from "./layout";

export type Provider = "claude" | "codex" | "opencode" | "agent";
export type AgentRunState = "idle" | "starting" | "working" | "waiting" | "blocked" | "stopped" | "failed";
export type PillBadge = "approval" | "finished" | "error";

/** Wire shape: what a shell gives the pill. */
export interface PillSnapshot {
  agents: Array<{ handle: string; provider: Provider; state: AgentRunState; activity: string[] }>;
  approvals: Array<{ id: string; agent: string; title: string; detail: string }>;
  /** Replies and notices from agents, newest last. */
  thread: Array<{ id: string; from: string; text: string }>;
}

export interface AgentTask {
  id: string;
  name: string;
  provider: Provider;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  pillBadge?: PillBadge | null;
}

export interface ApprovalInfo {
  id: string;
  agent: string;
  title: string;
  detail: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: false,
  soundVolume: 0.12,
  autoCloseInterval: 15,
};

export const PROVIDER_COLORS: Record<Provider, string> = {
  claude: "#D97757",
  codex: "#7AA2F7",
  opencode: "#34D399",
  agent: "#9AA1AC",
};

const RUN_TO_BOT: Record<AgentRunState, BotStateName> = {
  idle: "idle",
  starting: "thinking",
  working: "working",
  waiting: "thinking",
  blocked: "approval",
  stopped: "sleeping",
  failed: "error",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical window pixels, origin top-left. */
  mouse = { x: 0, y: 0 };
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  noteMessage: string | null = null;
  chatHistory: ChatMessage[] = [];
  approvals: ApprovalInfo[] = [];

  lastActivity = performance.now();
  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();
  private seenApprovals = new Set<string>();
  private lastThread = "";
  private threadSeeded = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn();
  }

  get pendingApproval(): ApprovalInfo | null {
    return this.approvals[0] ?? null;
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    const focus = this.focusTask?.id;
    return this.tasks.filter((t) => t.id !== focus);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  /** Applies a snapshot from the shell. Returns what is new, so the island can open on a fresh approval or reply. */
  apply(snapshot: PillSnapshot): { newApprovals: string[]; newReplies: PillSnapshot["thread"] } {
    const waiting = new Set(snapshot.approvals.map((a) => a.agent));
    this.tasks = snapshot.agents.map((a) => {
      const prev = this.tasks.find((t) => t.id === a.handle);
      const steps = a.activity.slice(-20);
      const finished = prev !== undefined && prev.state === "working" && a.state === "idle";
      return {
        id: a.handle,
        name: a.handle,
        provider: a.provider,
        color: PROVIDER_COLORS[a.provider] ?? PROVIDER_COLORS.agent,
        state: waiting.has(a.handle) ? "approval" : RUN_TO_BOT[a.state] ?? "idle",
        stepIndex: Math.max(0, steps.length - 1),
        steps,
        pillBadge: waiting.has(a.handle) ? "approval" : a.state === "failed" ? "error" : finished ? "finished" : prev?.pillBadge ?? null,
      };
    });
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = this.tasks[0]?.id ?? null;

    this.approvals = snapshot.approvals.map((a) => ({ ...a }));
    const newApprovals = this.approvals.filter((a) => !this.seenApprovals.has(a.id)).map((a) => a.id);
    for (const a of this.approvals) this.seenApprovals.add(a.id);

    // Replies are new when they come after the last one already seen; the very first snapshot only sets the baseline.
    const ids = snapshot.thread.map((m) => m.id);
    let newReplies: PillSnapshot["thread"] = [];
    if (this.threadSeeded) {
      const at = this.lastThread === "" ? 0 : ids.indexOf(this.lastThread) + 1;
      newReplies = at <= 0 && this.lastThread !== "" ? snapshot.thread : snapshot.thread.slice(at);
    }
    this.threadSeeded = true;
    this.lastThread = ids.at(-1) ?? this.lastThread;
    this.notify();
    return { newApprovals, newReplies };
  }

  defaultView(): IslandViewName {
    if (this.approvals.length > 0) return "approval";
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
