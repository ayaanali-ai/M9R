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
export interface PillUsageWindow {
  /** 0–100, as the provider reports it. */
  usedPercent: number;
  /** ISO time the window resets, when known. */
  resetsAt?: string;
}

export interface PillUsage {
  handle: string;
  fiveHour?: PillUsageWindow;
  weekly?: PillUsageWindow;
}

export interface PillMedia {
  title: string;
  artist?: string;
  source: "spotify" | "apple-music" | "other";
  playing: boolean;
}

export interface PillSnapshot {
  ownerWorkMode?: "working" | "agents-free";
  agents: Array<{ handle: string; provider: Provider; state: AgentRunState; activity: string[]; task?: string }>;
  /** Optional structured collaboration layer; older hosts may omit it. */
  collaboration?: PillCollaboration;
  /** Live provider-reported model choices; omitted when the host has no model surface. */
  models?: PillModelState;
  approvals: Array<{ id: string; agent: string; title: string; detail: string }>;
  /** Replies and notices from agents, newest last. */
  thread: Array<{ id: string; from: string; to?: string; text: string; link?: LinkOffer; dismissTaskId?: string }>;
  /** Browser-broker connection health, when the host can observe it. */
  connection?: "connecting" | "connected" | "disconnected";
  /** A connection-only update must not replace the last provider snapshot. */
  connectionOnly?: boolean;
  /** Browser shell only: the desktop pill is running, so this in-page pill should step aside. */
  desktopPill?: boolean;
  /** Plan limits exactly as each provider reports them, by agent handle. Absent until a provider reports; never estimated. */
  usage?: PillUsage[];
  /** What the OS says is playing, when the host can read it; null when nothing is. */
  media?: PillMedia | null;
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

/** A file handed to the pill. `path` is the real location on disk (desktop); a browser can only give the name. */
export interface DroppedFile {
  name: string;
  path?: string;
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

/** A past approval decision, kept once the live card is gone, for the identity panel's
 * "Approvals history" tab. Capped in State.resolveApproval -- it's a recent log, not an archive. */
export interface ApprovalHistoryEntry {
  id: string;
  agent: string;
  title: string;
  detail: string;
  decision: "allow" | "deny" | "allow_day";
  decidedAt: number;
}

/** One entry in the identity panel's "Activity" tab -- an agent task step, timestamped
 * the moment it was recorded (the host only ever gives us the step text, not a time). */
export interface ActivityEntry {
  agent: string;
  text: string;
  at: number;
}

/** The owner's own editable description of an agent -- Name/Character/Vibe/Emoji, the same
 * fields Muse's IDENTITY.md prompts for. Kept client-side only; nothing here is sent anywhere. */
export interface AgentIdentityDoc {
  name?: string;
  character?: string;
  vibe?: string;
  emoji?: string;
}

export interface ChatMessage {
  id: number;
  /** Stable host message identity. A streaming update edits this bubble in place. */
  sourceId?: string;
  role: "user" | "assistant";
  delivery?: "sending" | "accepted" | "unconfirmed";
  content: string;
  from?: string;
  to?: string;
  link?: LinkOffer;
  dismissTaskId?: string;
  /** Owner's own reaction to this message, chosen from the hover action row. Local-only: not sent to the host. */
  reaction?: string | null;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Say short updates out loud (a task finished, an agent needs you). */
  voiceEnabled: boolean;
  /** Speaking speed, 0.5–1.5. */
  voiceRate: number;
  /** How the notch's edge lights up: by what's happening, an always-on living rainbow, or never. */
  glowStyle: "status" | "rainbow" | "off";
  /** Optional owner-selected tint; null keeps the existing per-status colors. */
  glowColor: string | null;
  /** Default policy for approval requests: ask only for actions that share info or make
   * real changes, or ask before every single action regardless of how small. */
  approvalDefault: "ask_some" | "always_ask";
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: false,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  voiceEnabled: true,
  voiceRate: 1,
  glowStyle: "status",
  glowColor: null,
  approvalDefault: "ask_some",
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
  /** Settings renders as a modal over whatever view is active, not a swapped-in view of its own. */
  settingsOpen = false;
  /** Muse's avatar panel: an in-flow column on the right of whatever view is open, for the
   * focused agent. Stays open across view switches until its own close button is pressed. */
  identityOpen = false;

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical window pixels, origin top-left. */
  mouse = { x: 0, y: 0 };
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  noteMessage: string | null = null;
  /** Files dropped on the pill, waiting in the composer to go out with the next message. */
  pendingFiles: DroppedFile[] = [];
  /** Who a drop was aimed at; the composer takes this as its recipients once, then clears it. */
  composeTo: string[] | null = null;
  usage: PillUsage[] = [];
  media: PillMedia | null = null;
  /** Hold-to-talk is capturing right now. */
  listening = false;
  /** A spoken update is playing right now. */
  speaking = false;
  /** Where a file is being dragged over the island, in CSS pixels; null when nothing is being dragged. */
  dragPoint: { x: number; y: number } | null = null;
  chatHistory: ChatMessage[] = [];
  approvals: ApprovalInfo[] = [];
  /** Most recent decision first; capped to 50 so this stays a recent log, not an archive. */
  approvalHistory: ApprovalHistoryEntry[] = [];
  activityLog: ActivityEntry[] = [];
  identityDocs = new Map<string, AgentIdentityDoc>();
  brokerConnection: "unknown" | "connecting" | "connected" | "disconnected" = "unknown";
  collaboration: PillCollaboration | null = null;
  models: PillModelState | null = null;
  ownerWorkMode: "working" | "agents-free" = "working";
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
  apply(snapshot: PillSnapshot, now = Date.now()): { newApprovals: string[]; newReplies: PillSnapshot["thread"]; newFinished: string[] } {
    if (snapshot.connection) this.brokerConnection = snapshot.connection;
    if (snapshot.connectionOnly) {
      this.notify();
      return { newApprovals: [], newReplies: [], newFinished: [] };
    }

    this.collaboration = snapshot.collaboration ?? null;
    // A tick that doesn't carry "models" at all is a gap in that message, not a real "no agents" report --
    // keep whatever we last knew rather than flashing the picker empty. An explicit `{ agents: [] }` still clears it.
    if (snapshot.models !== undefined) this.models = snapshot.models;
    if (snapshot.ownerWorkMode !== undefined) this.ownerWorkMode = snapshot.ownerWorkMode;
    // Same rule: a tick that leaves these out is a gap, not "no limits" or "nothing playing".
    if (snapshot.usage !== undefined) this.usage = snapshot.usage;
    if (snapshot.media !== undefined) this.media = snapshot.media;

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
    const newFinished: string[] = [];
    const prevStepCounts = new Map(this.tasks.map((t) => [t.id, t.steps.length] as const));
    this.tasks = snapshot.agents.map((a) => {
      const steps = a.activity.slice(-20);
      // Provider snapshots carry availability, not a task completion receipt.

      // Timestamped the moment we first see it -- the host only hands us step text, not a
      // time, so "now" is the closest honest stamp for the identity panel's Activity tab.
      const prevCount = prevStepCounts.get(a.handle) ?? 0;
      for (const text of steps.slice(prevCount)) this.activityLog.unshift({ agent: a.handle, text, at: now });
      if (this.activityLog.length > 100) this.activityLog.length = 100;

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
        pillBadge: waiting.has(a.handle) ? "approval" : a.state === "failed" ? "error" : null,
      };
    });
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = this.tasks[0]?.id ?? null;

    const newApprovals = confirmed.filter((a) => !this.seenApprovals.has(a.id)).map((a) => a.id);
    for (const a of this.approvals) this.seenApprovals.add(a.id);

    // The first authoritative snapshot hydrates the visible transcript without firing arrival effects.
    // A disconnect carries no authority to seed or replace conversation history.
    const ids = snapshot.thread.map((m) => m.id);
    let newReplies: PillSnapshot["thread"] = [];
    // The owner's own messages come back through the shared thread; they are the owner's bubble, not an agent reply.
    const own = (message: PillSnapshot["thread"][number]) => message.from === "you";
    const content = (message: PillSnapshot["thread"][number]) => own(message) ? message.text : `${message.from}: ${message.text}`;
    if (!this.threadSeeded && snapshot.connection !== "disconnected") {
      this.chatHistory = snapshot.thread.map((message, index) => ({
        id: Date.now() + index,
        sourceId: message.id,
        role: own(message) ? "user" : "assistant",
        content: content(message),
        from: message.from,
        to: message.to,
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
          existing.content = content(message);
          existing.from = message.from;
          existing.to = message.to;
          existing.link = message.link;
          existing.dismissTaskId = message.dismissTaskId;
        }
      }
      for (const message of newReplies) {
        // The bubble the owner just typed is already on screen; claim it instead of showing a second copy.
        const typed = own(message)
          ? this.chatHistory.find((entry) => entry.role === "user" && entry.sourceId === undefined && entry.content === message.text.trim())
          : undefined;
        if (typed) {
          typed.sourceId = message.id;
          typed.delivery = "accepted";
          continue;
        }
        this.chatHistory.push({
          id: Date.now() + this.chatHistory.length,
          sourceId: message.id,
          role: own(message) ? "user" : "assistant",
          content: content(message),
          from: message.from,
          to: message.to,
          link: message.link,
          dismissTaskId: message.dismissTaskId,
        });
      }
      newReplies = newReplies.filter((message) => !own(message));
      this.lastThread = ids.at(-1) ?? this.lastThread;
    }
    this.notify();
    return { newApprovals, newReplies, newFinished };
  }

  dismissChatMessage(id: number) {
    this.chatHistory = this.chatHistory.filter((message) => message.id !== id);
    this.notify();
  }

  /** Toggles the owner's reaction on a message; picking the same emoji again clears it. */
  setReaction(id: number, emoji: string) {
    const message = this.chatHistory.find((m) => m.id === id);
    if (!message) return;
    message.reaction = message.reaction === emoji ? null : emoji;
    this.notify();
  }

  /** Remove an approval only after the transport accepted the owner's decision. */
  resolveApproval(id: string, decision: "allow" | "deny" | "allow_day", now = Date.now()) {
    this.resolvedApprovals.set(id, now);
    const resolved = this.approvals.find((approval) => approval.id === id);
    const agent = resolved?.agent;
    if (resolved) {
      this.approvalHistory.unshift({ id: resolved.id, agent: resolved.agent, title: resolved.title, detail: resolved.detail, decision, decidedAt: now });
      this.approvalHistory.length = Math.min(this.approvalHistory.length, 50);
    }
    this.approvals = this.approvals.filter((approval) => approval.id !== id);
    // Don't leave the agent saying "Needs you" until the next snapshot happens to arrive.
    const task = agent && !this.approvals.some((approval) => approval.agent === agent) ? this.tasks.find((t) => t.id === agent) : undefined;
    if (task?.state === "approval") {
      task.state = RUN_TO_BOT[task.runState] ?? "idle";
      if (task.pillBadge === "approval") task.pillBadge = null;
    }
    if (this.decisionError?.approvalId === id) this.decisionError = null;
  }

  setIdentityDoc(agentId: string, doc: AgentIdentityDoc) {
    this.identityDocs.set(agentId, doc);
    this.notify();
  }

  setDecisionError(approvalId: string, message: string | null) {
    this.decisionError = message ? { approvalId, message } : null;
    this.notify();
  }

  defaultView(): IslandViewName {
    // Approvals render as inline cards in the one main chat, not a separate screen, so
    // a pending approval no longer forces a distinct default view.
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
