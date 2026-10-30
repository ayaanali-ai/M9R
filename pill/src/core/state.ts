// Pill state. One shape for both shells: the desktop window and the in-page frame each hand the pill a PillSnapshot
// (agents, approvals, thread) and receive owner commands back through the transport. Nothing here knows about Tauri or Chrome.

import type { BotStateName, IslandMode, IslandViewName } from "./layout";
import type { PillCollaboration, PillPresenceState } from "./presence";

export type Provider = "claude" | "codex" | "opencode" | "agent";
export type AgentRunState = "idle" | "starting" | "working" | "waiting" | "blocked" | "stopped" | "failed" | "seen" | "unknown" | "not_connected";
export type PillBadge = "approval" | "finished" | "error";

export interface PillModelEffort { id: string; label: string }
export interface PillModelOption { id: string; label: string; efforts: PillModelEffort[] | null; description?: string }
export interface PillModelAgent {
  handle: string;
  provider: string;
  availability: "available" | "not_connected" | "catalog_unavailable";
  models: PillModelOption[];
  currentModel: string | null;
  currentEffort: string | null;
  selectedModel?: string | null;
  selectedEffort?: string | null;
  status: string;
}
export interface PillModelState { agents: PillModelAgent[] }

/** Wire shape: what a shell gives the pill. */
export interface PillSnapshot {
  agents: Array<{ handle: string; provider: Provider; state: AgentRunState; activity: string[]; task?: string }>;
  /** Optional structured collaboration layer; older hosts may omit it. */
  collaboration?: PillCollaboration;
  /** Live provider-reported model choices; omitted when the host has no model surface. */
  models?: PillModelState;
  approvals: Array<{ id: string; agent: string; title: string; detail: string }>;
  /** Replies and notices from agents, newest last. */
  thread: Array<{ id: string; from: string; text: string; link?: LinkOffer; dismissTaskId?: string }>;
  /** Browser-broker connection health, when the host can observe it. */
  connection?: "connecting" | "connected" | "disconnected";
  /** A connection-only update must not replace the last provider snapshot. */
  connectionOnly?: boolean;
  /** Browser shell only: the desktop pill is running, so this in-page pill should step aside. */
  desktopPill?: boolean;
}

/** A message that could not be delivered, with the details needed to pick a session to link and try again. */
export interface LinkOffer {
  taskId: string;
  from: string;
  fromSession?: string;
  to: string;
}

export interface AgentTask {
  id: string;
  name: string;
  provider: Provider;
  color: string;
  state: BotStateName;
  /** Evidence-based provider status; kept separate from animation state. */
  runState: AgentRunState;
  stepIndex: number;
  steps: string[];
  /** Current task goal supplied by the host feed when one is active. */
  task?: string;
  pillBadge?: PillBadge | null;
  presenceState?: PillPresenceState;
}

export interface ApprovalInfo {
  id: string;
  agent: string;
  title: string;
  detail: string;
  /** A poll omitted this approval; keep it visible but warn that the server must revalidate a decision. */
  unconfirmed?: boolean;
  unconfirmedSince?: number;
}

export interface ChatMessage {
  id: number;
  /** Stable host message identity. A streaming update edits this bubble in place. */
  sourceId?: string;
  role: "user" | "assistant";
  content: string;
  link?: LinkOffer;
  dismissTaskId?: string;
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
  seen: "unknown",
  unknown: "unknown",
  not_connected: "unknown",
};

type Listener = () => void;
const APPROVAL_RECOVERY_MS = 24 * 60 * 60_000;

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
  brokerConnection: "unknown" | "connecting" | "connected" | "disconnected" = "unknown";
  collaboration: PillCollaboration | null = null;
  models: PillModelState | null = null;
  decisionError: { approvalId: string; message: string } | null = null;

  lastActivity = performance.now();
  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();
  private seenApprovals = new Set<string>();
  private resolvedApprovals = new Map<string, number>();
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
  apply(snapshot: PillSnapshot, now = Date.now()): { newApprovals: string[]; newReplies: PillSnapshot["thread"] } {
    if (snapshot.connection) this.brokerConnection = snapshot.connection;
    if (snapshot.connectionOnly) {
      this.notify();
      return { newApprovals: [], newReplies: [] };
    }

    this.collaboration = snapshot.collaboration ?? null;
    this.models = snapshot.models ?? null;

    for (const [id, resolvedAt] of this.resolvedApprovals) {
      if (now - resolvedAt >= APPROVAL_RECOVERY_MS) this.resolvedApprovals.delete(id);
    }
    const currentApprovals = snapshot.approvals.filter((approval) => !this.resolvedApprovals.has(approval.id));
    const incomingIds = new Set(currentApprovals.map((approval) => approval.id));
    const confirmed = currentApprovals.map((approval) => ({ ...approval, unconfirmed: false, unconfirmedSince: undefined }));
    const recovered = this.approvals
      .filter((approval) => !incomingIds.has(approval.id)
        && !this.resolvedApprovals.has(approval.id)
        && now - (approval.unconfirmedSince ?? now) < APPROVAL_RECOVERY_MS)
      .map((approval) => ({ ...approval, unconfirmed: true, unconfirmedSince: approval.unconfirmedSince ?? now }));
    this.approvals = [...confirmed, ...recovered];
    if (this.decisionError && !this.approvals.some((approval) => approval.id === this.decisionError?.approvalId)) {
      this.decisionError = null;
    }
    const waiting = new Set(this.approvals.map((a) => a.agent));
    this.tasks = snapshot.agents.map((a) => {
      const prev = this.tasks.find((t) => t.id === a.handle);
      const steps = a.activity.slice(-20);
      const finished = prev !== undefined && prev.state === "working" && a.state === "idle";
      return {
        id: a.handle,
        name: a.handle,
        provider: a.provider,
        // A known provider's brand color is its fixed identity and must never be overridden by a
        // presence-hash color; the hash only stands in for a provider with no fixed brand (bare "agent").
        color: a.provider !== "agent"
          ? PROVIDER_COLORS[a.provider]
          : this.collaboration?.agents.find((presence) => presence.agentId === a.handle)?.color ?? PROVIDER_COLORS.agent,
        state: waiting.has(a.handle) ? "approval" : RUN_TO_BOT[a.state] ?? "idle",
        runState: a.state,
        stepIndex: Math.max(0, steps.length - 1),
        steps,
        ...(a.task ? { task: a.task } : {}),
        ...(this.collaboration?.agents.find((presence) => presence.agentId === a.handle)?.state ? { presenceState: this.collaboration.agents.find((presence) => presence.agentId === a.handle)!.state } : {}),
        pillBadge: waiting.has(a.handle) ? "approval" : a.state === "failed" ? "error" : finished ? "finished" : prev?.pillBadge ?? null,
      };
    });
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = this.tasks[0]?.id ?? null;

    const newApprovals = confirmed.filter((a) => !this.seenApprovals.has(a.id)).map((a) => a.id);
    for (const a of this.approvals) this.seenApprovals.add(a.id);

    // The first authoritative snapshot hydrates the visible transcript without firing arrival effects.
    // A disconnect carries no authority to seed or replace conversation history.
    const ids = snapshot.thread.map((m) => m.id);
    let newReplies: PillSnapshot["thread"] = [];
    if (!this.threadSeeded && snapshot.connection !== "disconnected") {
      this.chatHistory = snapshot.thread.map((message, index) => ({
        id: Date.now() + index,
        sourceId: message.id,
        role: "assistant",
        content: `${message.from}: ${message.text}`,
        link: message.link,
        dismissTaskId: message.dismissTaskId,
      }));
      this.threadSeeded = true;
      this.lastThread = ids.at(-1) ?? "";
    } else if (this.threadSeeded && snapshot.connection !== "disconnected") {
      const at = this.lastThread === "" ? 0 : ids.indexOf(this.lastThread) + 1;
      newReplies = at <= 0 && this.lastThread !== ""
        ? snapshot.thread.filter((message) => !this.chatHistory.some((entry) => entry.sourceId === message.id))
        : snapshot.thread.slice(at);
      for (const message of snapshot.thread) {
        const existing = this.chatHistory.find((entry) => entry.sourceId === message.id);
        if (existing) {
          existing.content = `${message.from}: ${message.text}`;
          existing.link = message.link;
          existing.dismissTaskId = message.dismissTaskId;
        }
      }
      for (const message of newReplies) {
        this.chatHistory.push({
          id: Date.now() + this.chatHistory.length,
          sourceId: message.id,
          role: "assistant",
          content: `${message.from}: ${message.text}`,
          link: message.link,
          dismissTaskId: message.dismissTaskId,
        });
      }
      this.lastThread = ids.at(-1) ?? this.lastThread;
    }
    this.notify();
    return { newApprovals, newReplies };
  }

  dismissChatMessage(id: number) {
    this.chatHistory = this.chatHistory.filter((message) => message.id !== id);
    this.notify();
  }

  /** Remove an approval only after the transport accepted the owner's decision. */
  resolveApproval(id: string, now = Date.now()) {
    this.resolvedApprovals.set(id, now);
    this.approvals = this.approvals.filter((approval) => approval.id !== id);
    if (this.decisionError?.approvalId === id) this.decisionError = null;
  }

  setDecisionError(approvalId: string, message: string | null) {
    this.decisionError = message ? { approvalId, message } : null;
    this.notify();
  }

  defaultView(): IslandViewName {
    if (this.approvals.length > 0) return "approval";
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
