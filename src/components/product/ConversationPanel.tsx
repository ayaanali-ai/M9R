"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { Circle, Reply, X, Trash2, Pencil, Clock, AlertTriangle, RotateCcw, SlidersHorizontal, Square, Inbox as InboxIcon, LogOut } from "lucide-react";
import { ChannelWelcome } from "./ChannelWelcome";
import { useComposerAutosize } from "./useComposerAutosize";
import { BorderBeam } from "border-beam";
import { TerminalWorkspace, type PtyRoomSession } from "./TerminalWorkspace";
import { TERMINAL_ENABLED } from "@/lib/terminal-config";
import { AttachIcon, MentionIcon, SendIcon } from "@/components/product/wf-icons";
import { AgentMark, AGENT_BRAND_COLOR } from "@/components/product/WorkspaceUI";
import ProductConfirmDialog from "@/components/product/ProductConfirmDialog";
import { type AgentView } from "@/lib/agent-workspace-data";
import { getAgentDisplayName } from "@/lib/agent-identity";
import { WorkspaceRelayBrowserClient, type BrowserMissionRelayStatus } from "@/lib/mission/mission-relay-browser-client";
import type { RelayFrame } from "@/lib/mission/mission-relay-protocol";
import { initialsFor, identityHue } from "@/lib/identity-color";
import { channelDisplayName, channelGroupForConversation } from "@/lib/workspace-channel-groups";
import { channelHref } from "@/lib/run-navigation";
import { getModelTier, tierLabel } from "@/lib/cost-model";
import { TaskCard, type TaskCardContract } from "@/components/product/agent-workspace/task-card";
import MessageBody from "@/components/product/MessageBody";

/**
 * Fixes a real display bug: the previous mapping only special-cased
 * "subscribed" and "error", so the client's actual "reconnecting" status
 * (emitted during genuine retry backoff -- see mission-relay-browser-
 * client.ts's connect()) fell through to "connecting", while "error" was
 * mislabeled as the calmer "reconnecting". A real connection error now
 * reads as an error, not as a permanent-feeling "reconnecting".
 */
function relayStatusLabel(status: BrowserMissionRelayStatus, httpFallback = false): string {
  if (httpFallback) return "HTTP fallback";
  switch (status) {
    case "subscribed": return "live";
    case "authenticated": return "syncing";
    case "reconnecting": return "reconnecting";
    case "error": return "connection issue";
    case "closed": return "disconnected";
    case "connecting":
    case "idle":
    default: return "connecting";
  }
}

const GROUPING_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Passive /route nudge (advisory only, human decides -- see the note on
 * ModelOverrideControl in strip-board.tsx for where the actual switch
 * happens; this component only surfaces the suggestion, it never reroutes
 * anything itself). Deliberately conservative: only fires when the draft
 * looks genuinely multi-step/architectural AND the mentioned agent's model
 * is a *known* light tier -- an unknown model (no override set) says
 * nothing about capability, so it's left alone rather than guessed at.
 */
const COMPLEX_TASK_PATTERN = /\b(refactor|migrat(e|ion)|architect(ure)?|redesign|rewrite|across (the |multiple )?(codebase|files|repo)|multi-file|end-to-end)\b/i;
function draftLooksComplex(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 260) return true;
  if ((trimmed.match(/\n/g) ?? []).length >= 2) return true;
  return COMPLEX_TASK_PATTERN.test(trimmed);
}

/** B-4: Normal/Verbose/Summary, the idiom Claude Code Desktop documents for
 * Ctrl+O -- Summary exists specifically for scanning multiple concurrent
 * sessions, which is this workspace's exact multi-agent situation. */
type TranscriptVerbosity = "normal" | "verbose" | "summary";
const VERBOSITY_LABEL: Record<TranscriptVerbosity, string> = { normal: "Normal", verbose: "Verbose", summary: "Summary" };

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string, now: number | null): string {
  if (now === null) return "…";
  const date = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/** Slack-style consecutive-message grouping: the same sender posting within a short window collapses into one visual group -- only the first message shows the avatar/name, the rest render as slim follow-up rows. Also marks day boundaries for date dividers. */
function groupMessages(messages: ConversationMessage[]): Array<{ message: ConversationMessage; isGroupStart: boolean; isNewDay: boolean }> {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const isNewDay = !previous || dayKey(previous.created_at) !== dayKey(message.created_at);
    const sameSender = !!previous && previous.sender_connection_id === message.sender_connection_id && previous.sender_user_id === message.sender_user_id;
    const withinWindow = !!previous && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < GROUPING_WINDOW_MS;
    const isGroupStart = isNewDay || !sameSender || !withinWindow || !!message.parent_message_id;
    return { message, isGroupStart, isNewDay };
  });
}

function mergeConversationMessages(existing: ConversationMessage[], incoming: ConversationMessage[]): ConversationMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
}

/** Groups a message's reactions by emoji into pills with a count and whether the current viewer has reacted -- actor_user_id "current-user" matches the optimistic local-echo shape toggleReaction already writes (see toggleReaction below), so a pill reflects the viewer's own toggle instantly. */
function reactionPills(message: ConversationMessage): Array<{ emoji: string; count: number; mine: boolean }> {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const reaction of message.reactions) {
    const entry = byEmoji.get(reaction.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (reaction.actor_user_id === "current-user") entry.mine = true;
    byEmoji.set(reaction.emoji, entry);
  }
  return [...byEmoji.entries()].map(([emoji, value]) => ({ emoji, ...value }));
}

/**
 * The root cause of a real, reproducible crash-and-reload: a brand-new
 * message coming off the live relay (onSnapshot, the workspace.event frame,
 * and the relay's own postMessage ack) was cast straight to
 * `ConversationMessage` with no runtime check -- the wire payload for a
 * message that genuinely has no reactions/attachments yet can omit those
 * keys entirely. `message.attachments.length` (rendered on every message)
 * then threw on `undefined`, which is exactly "Cannot read properties of
 * undefined (reading 'length')" -- the error the dashboard's stale-bundle
 * auto-reload was silently mopping up after every single time, on every
 * message, unrelated to any actual stale bundle. sendDashboardConversationMessage
 * (the HTTP path) already learned this the hard way and normalizes on its
 * own return; the relay path never did. One normalizer, applied at every
 * point raw relay JSON becomes a ConversationMessage.
 */
function normalizeIncomingMessage(raw: ConversationMessage): ConversationMessage {
  return { ...raw, reactions: raw.reactions ?? [], attachments: raw.attachments ?? [], todos: raw.todos ?? [] };
}

/**
 * One agent's live checklist on one message -- ACP's native `plan` entries,
 * carried verbatim (status stays ACP's own pending/in_progress/completed
 * rather than a parallel frontend vocabulary, so a stored row and a live
 * frame never need translating between them).
 *
 * Keyed by connection as well as message because the anchor is the message
 * that TRIGGERED the turn, not the agent's own reply (which does not exist
 * until the turn ends) -- and two agents can be working the same anchor at
 * once, exactly as the per-connection turn indicator already assumes.
 */
interface MessageTodo {
  message_id: string;
  connection_id: string;
  entries: Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority: "high" | "medium" | "low" }>;
  updated_at: string;
}

interface ConversationMessage {
  id: string;
  sender_connection_id: string | null;
  sender_user_id: string | null;
  sender_display_name: string | null;
  recipient_connection_id: string | null;
  kind: "message" | "handoff" | "ack" | "result" | "notice";
  body: string;
  /** Only meaningful for kind:"result" -- whether the turn actually
   * succeeded. Null/undefined means unknown and renders with no outcome
   * tint, never guessed as success. */
  outcome?: "ok" | "failed" | "incomplete" | null;
  created_at: string;
  spawned_run_id: string | null;
  /** The run this message is *about* (a run-start request, an evidence
   * submission, a permission request) -- see conversation-service.ts's
   * ConversationMessage doc comment for how this differs from
   * spawned_run_id. */
  related_run_id?: string | null;
  parent_message_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  reactions: Array<{ id: string; message_id: string; emoji: string; actor_user_id: string | null; actor_connection_id: string | null }>;
  attachments: Array<{ id: string; name: string; mediaType: string; sizeBytes: number; url: string }>;
  /** The agent checklist(s) attached to this message, as last persisted.
   * Live revisions arrive separately as `workspace.todos` relay frames and
   * are held in `liveTodos` -- see todosForMessage. */
  todos: MessageTodo[];
  /**
   * Optimistic-echo state, local-only (never comes from the server). "pending"
   * shows a live indicator while the real post is in flight; "failed" shows a
   * retry, never a silent disappearance. Absent once the server has confirmed
   * this message -- a confirmed message must never look provisional again.
   */
  sendStatus?: "pending" | "failed";
  /** Carried on the local echo so a server ack (or a retry) can find and
   * replace this exact row instead of appending a duplicate. */
  clientRequestId?: string;
}

interface Conversation {
  id: string;
  topic: string;
  channel_slug: string | null;
  channel_kind: "channel" | "dm";
  status: "open" | "closed";
  created_at: string;
  participant_connection_ids: string[];
  description: string | null;
  is_private: boolean;
  unread_count: number;
  messages: ConversationMessage[];
  mission_id: string | null;
  /** Loop-prevention Layer 3: non-null means a human has paused agent
   * delivery here. The bridge checks this before it will wake any session
   * for this conversation, including on an explicit @mention. */
  agent_replies_paused_at: string | null;
}

interface PendingEvidenceRequest {
  id: string;
  conversationId: string;
  agentConnectionId: string;
  provider: string | null;
  requestSummary: string;
  requestMessageId: string | null;
  createdAt: string;
}

interface PendingRunStartApproval {
  id: string;
  connectionId: string;
  riskClassification: string;
  sensitiveAreas: string[];
  requestMessageId: string | null;
  createdAt: string;
  expiresAt: string;
}

/** "expires in 6:12" -- counts down live off the same ticking `now` clock the message timestamps already use. Never negative/backwards once past expiry. */
function expiryCountdown(expiresAtIso: string, nowMs: number | null): string | null {
  if (nowMs === null) return null;
  const ms = Date.parse(expiresAtIso) - nowMs;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "expired";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface PendingFinding {
  id: string;
  title: string;
  observedBehavior: string;
  evidenceLevel: string;
  announcementMessageId: string | null;
  createdAt: string;
}

interface PendingRuleDraft {
  id: string;
  title: string;
  body: string;
  announcementMessageId: string | null;
  createdAt: string;
}

interface PendingBridgePermission {
  id: string;
  summary: string;
  command: string | null;
  filePath: string | null;
  messageId: string | null;
  createdAt: string;
}

interface PendingEvidenceSubmission {
  id: string;
  provider: string | null;
  summary: string;
  evidence: {
    work: string[];
    files: string[];
    verification: Array<{ command: string; result: string }>;
    limitations: string[];
  } | null;
  messageId: string | null;
  createdAt: string;
}

/**
 * A-6: one real step of provider activity (a file read, a command, a tool
 * call), attached to the specific message/turn that produced it -- carried
 * over the new `workspace.step` relay frame (mission-relay-client.ts /
 * mission-relay-service.ts), emitted from the bridge's own turn loop
 * (bridge-runtime.ts's runQueuedPrompts). Never an invented phase: `kind`
 * and `summary` are only ever real ACP provider.activity fields.
 */
export interface WorkspaceStep {
  stepId: string;
  messageId: string;
  /** The agent connection whose turn produced this step. Null only for a
   * step from a bridge that hasn't resolved its own connection id yet. */
  connectionId: string | null;
  kind: string;
  status: "started" | "succeeded" | "failed" | "waiting";
  summary: string;
  filePath: string | null;
  command: string | null;
  receivedAtMs: number;
  /** The durable workspace_file_activity row this step was also written to
   * (see bridge-runtime.ts's provider.activity handling) -- null for
   * anything that isn't a real file read/edit (commands, etc). Lets a live
   * listener (the Files panel) fetch the real diff by id. */
  activityId?: string | null;
  additions?: number | null;
  deletions?: number | null;
}

/**
 * One agent's live turn in this channel, keyed by its connection id so two
 * agents working at once each get their own indicator instead of sharing a
 * single global flag (the old `pendingAgentTurn`, which could only ever be
 * right about one of them).
 *
 * `confirmed` is the whole point of the rework: it is true only once the
 * owning Bridge really entered its provider turn (the `workspace.turn`
 * relay frame, or any real step from that connection). An unconfirmed entry
 * is the composer's own zero-latency optimism about the @mention it just
 * sent, and it expires on its own within seconds -- live tonight, the
 * regex-on-send guess plus a 5-minute timeout kept "Claude Code is working…"
 * on screen for 15+ minutes in a channel where agent replies were paused and
 * nothing had ever started.
 */
interface AgentTurnState {
  connectionId: string;
  startedAtMs: number;
  confirmed: boolean;
  /** The message this turn is answering, once the backend names it -- also what the step log groups by. */
  messageId: string | null;
  action: { kind: string; status: WorkspaceStep["status"]; summary: string; filePath: string | null; command: string | null } | null;
  ended: { outcome: "ok" | "failed" | "cancelled" | "incomplete"; detail: string | null; atMs: number } | null;
}

/** How long an unconfirmed, optimistic entry may stand before the absence of
 * any real backend signal is itself the answer. Was 20s, live-caught as too
 * short: a real multi-agent handoff (message queued behind another agent's
 * turn, or waiting on the batch-dequeue window in bridge-runtime.ts's
 * runQueuedPrompts) can genuinely take longer than that to produce its first
 * confirming signal, and the indicator vanishing during that gap read as
 * "did this fail?" even though nothing was wrong -- it just hadn't started
 * yet. Long enough to cover that queueing latency, short enough to still
 * eventually give up on a truly dead @mention (the original problem this
 * constant existed to solve, a stale "is working…" for 15+ minutes). */
const OPTIMISTIC_TURN_GRACE_MS = 90_000;
/** How long a finished turn's terminal line stays up. Only failed/cancelled
 * turns get one -- "did my Stop actually do anything" is exactly the
 * feedback that was missing; a clean finish needs no epitaph. */
const ENDED_TURN_LINGER_MS = 6_000;

interface NotificationItem {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

const KIND_LABEL: Record<ConversationMessage["kind"], string> = {
  message: "message",
  handoff: "handoff",
  ack: "ack",
  result: "result",
  notice: "notice",
};

/**
 * "What can I say" shortcuts — a human-usable entry point into the same
 * Mission message-type vocabulary agents already emit through the
 * collaboration protocol (mission-domain.ts's MESSAGE_TYPES). Typing one of
 * these prefixes is parsed server-side (conversation-service.ts's
 * parseStructuredMessagePrefix) into a real Mission messageType instead of
 * always posting "information" — this is what makes the affordance connect
 * to governance rather than just insert cosmetic text.
 */
const MESSAGE_SHORTCUTS: Array<{ prefix: string; label: string; hint: string }> = [
  { prefix: "/review", label: "Review request", hint: "Ask an agent to review specific work" },
  { prefix: "/finding", label: "Finding", hint: "Raise an issue that needs a response" },
  { prefix: "/blocker", label: "Blocker", hint: "Flag work that cannot proceed" },
  { prefix: "/delegate", label: "Delegate", hint: "Hand bounded work to another agent" },
  { prefix: "/evidence", label: "Evidence notice", hint: "Point at evidence already recorded" },
  { prefix: "/question", label: "Question", hint: "Ask something that needs an answer" },
];

/** Splits draft text on `@name` tokens and wraps the ones that match a real,
 * connected agent key in a highlight span -- the backdrop that sits behind
 * the composer's textarea (see the note above where this is called). Must
 * stay a pure text->nodes function: it renders into an aria-hidden mirror,
 * never the actual editable content, so it can never diverge from what the
 * textarea holds. */
function renderHighlightedDraft(draft: string, knownKeys: Set<string>): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /@[a-zA-Z0-9_-]+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(draft))) {
    if (match.index > lastIndex) nodes.push(draft.slice(lastIndex, match.index));
    const token = match[0];
    const isKnown = knownKeys.has(token.slice(1).toLowerCase());
    nodes.push(isKnown ? <mark key={key++} className="wf-chat-mention-highlight">{token}</mark> : token);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < draft.length) nodes.push(draft.slice(lastIndex));
  // A trailing newline in a textarea needs an extra blank line to render at
  // the same height as the real control -- otherwise the backdrop's last
  // line collapses and the highlight drifts out of alignment as you type.
  if (draft.endsWith("\n")) nodes.push("\n");
  return nodes;
}

function relativeTime(iso: string, nowMs: number | null): string {
  // Keep the server render deterministic. The live clock starts after
  // hydration so timestamps cannot produce a server/client markup mismatch.
  if (nowMs === null) return "…";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const secs = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/**
 * D1: message timestamps in the live log read as absolute clock time, not
 * relative -- "2m ago" on a group header keeps drifting/re-rendering and is
 * noise in an ops log where you actually want "when did this happen."
 * Relative time stays where it's genuinely useful: the sidebar and inbox.
 */
function absoluteTime(iso: string, nowMs: number | null): string {
  if (nowMs === null) return "…";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Most recently active conversation first -- last message time, falling back to channel creation for one with no messages yet. */
function lastActivityMs(conversation: Conversation): number {
  const lastMessage = conversation.messages[conversation.messages.length - 1];
  return Date.parse(lastMessage?.created_at ?? conversation.created_at);
}

/**
 * A-1: the live send-status affordance. Ticks its own local 1s interval --
 * scoped to this one row, not the shared 5s `now` clock -- so a pending
 * send never triggers a re-render of the rest of the feed (that coupling is
 * the exact bug A-5 targets separately; this must not reintroduce it).
 * "pending" never claims delivered; "failed" never disappears silently.
 */
function SendStatusIndicator({ message, onRetry }: { message: ConversationMessage; onRetry: (message: ConversationMessage) => void }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (message.sendStatus !== "pending") return;
    const startedAtMs = Date.parse(message.created_at);
    const tick = () => setElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [message.sendStatus, message.created_at]);

  if (message.sendStatus === "failed") {
    return (
      <button type="button" className="wf-chat-send-status wf-chat-send-status--failed" onClick={() => onRetry(message)}>
        <AlertTriangle size={12} aria-hidden />
        <span>Not sent. Retry</span>
        <RotateCcw size={11} aria-hidden />
      </button>
    );
  }
  const mm = Math.floor(elapsedSeconds / 60);
  const ss = String(elapsedSeconds % 60).padStart(2, "0");
  return (
    <span className="wf-chat-send-status wf-chat-send-status--pending" aria-live="polite">
      <Clock size={12} aria-hidden />
      <span>Sending… {mm}:{ss}</span>
    </span>
  );
}

/**
 * The running-state text, in the idiom of the provider CLIs' own indicators
 * (Claude Code, Codex): a specific verb and its real target, never a generic
 * "is working…". Every branch below reads a field the provider actually sent
 * -- `command` and `filePath` are the ACP tool call's own fields (see
 * acp-stdio-adapter.ts's ActivityPayload), and `summary` is its title. The
 * one phase named without a matching tool call is "Thinking…", which is
 * exactly what a confirmed-live turn with no tool activity yet is doing; it
 * is never shown for an unconfirmed turn.
 */
function turnStateLabel(turn: AgentTurnState): string {
  if (turn.ended) {
    if (turn.ended.outcome === "cancelled") return "Stopped";
    if (turn.ended.outcome === "failed") return turn.ended.detail ? `Failed: ${turn.ended.detail}` : "Failed";
    return "Done";
  }
  if (!turn.confirmed) return "Waiting to start…";
  const action = turn.action;
  if (!action) return "Thinking…";
  if (action.kind === "permission.requested") return `Waiting for permission: ${action.summary}`;
  if (action.command) return `Running ${action.command}`;
  if (action.filePath) return `${action.kind === "file.changed" ? "Editing" : "Reading"} ${action.filePath}`;
  return action.summary;
}

/**
 * A-2, reworked: elapsed time + the agent's real current action, in the
 * Codex CLI idiom ("23m 49s"). One line per agent connection with a live
 * turn -- two agents working in the same channel each get their own, which
 * the old single global indicator structurally could not do.
 *
 * The stop control lives here only when more than one turn is running, since
 * the composer's single Stop button cannot say which agent it means; with
 * one turn the composer keeps it (that placement was a deliberate earlier
 * decision and is not being undone).
 */
/** Shared Live Sessions presence: option A, overlapping avatar circles --
 * the Google Docs/Figma idiom, chosen over a bare count or named pills.
 * Channel-scoped, not per-turn (the relay's presence tracking doesn't know
 * which specific live turn a human has scrolled to) -- accepted v1 limit,
 * noted in the design pass rather than silently glossed over. */
function PresenceAvatars({ participantIds, roster }: { participantIds: string[]; roster: Map<string, string> }) {
  if (participantIds.length === 0) return null;
  const shown = participantIds.slice(0, 3);
  const overflow = participantIds.length - shown.length;
  return (
    <span className="wf-chat-liveness-presence" title={`${participantIds.map((id) => roster.get(id) ?? id).join(", ")} watching`}>
      {shown.map((id, index) => {
        const label = roster.get(id) ?? id;
        return (
          <span key={id} className="wf-chat-presence-avatar" style={{ background: `hsl(${identityHue(id)}, 45%, 32%)`, color: `hsl(${identityHue(id)}, 60%, 88%)`, zIndex: shown.length - index }}>
            {initialsFor(label)}
          </span>
        );
      })}
      {overflow > 0 && <span className="wf-chat-presence-avatar wf-chat-presence-overflow">+{overflow}</span>}
    </span>
  );
}

function AgentLivenessLine({ name, turn, onStop, stopping, watcherIds, roster, onHandOff }: { name: string; turn: AgentTurnState; onStop: (() => void) | null; stopping: boolean; watcherIds: string[]; roster: Map<string, string>; onHandOff: (() => void) | null }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.max(0, Math.round((Date.now() - turn.startedAtMs) / 1000)));
  const settled = Boolean(turn.ended);
  useEffect(() => {
    const tick = () => setElapsedSeconds(Math.max(0, Math.round((Date.now() - turn.startedAtMs) / 1000)));
    tick();
    if (settled) return;
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [turn.startedAtMs, settled]);
  const mins = Math.floor(elapsedSeconds / 60);
  const secs = String(elapsedSeconds % 60).padStart(2, "0");
  return (
    <p className="wf-chat-typing wf-chat-liveness" data-settled={settled || undefined} data-outcome={turn.ended?.outcome} aria-live="polite">
      <span className="ol-mono">{mins}:{secs}</span>
      <span className="wf-chat-liveness-name">{name}</span>
      <span className="wf-chat-liveness-action">{turnStateLabel(turn)}</span>
      <PresenceAvatars participantIds={watcherIds} roster={roster} />
      {onStop && !settled && (
        <button type="button" className="wf-chat-liveness-stop" disabled={stopping} onClick={onStop} title={`Stop ${name}'s current turn`} aria-label={`Stop ${name}'s current turn`}>
          <Square size={9} fill="currentColor" aria-hidden /> {stopping ? "Stopping…" : "Stop"}
        </button>
      )}
      {onHandOff && !settled && (
        <button type="button" className="wf-chat-liveness-handoff" onClick={onHandOff} title="Done watching -- let someone else pick this up" aria-label="Done watching -- let someone else pick this up">
          <LogOut size={11} aria-hidden />
        </button>
      )}
    </p>
  );
}

/**
 * A-5: the one place that genuinely needs a live per-second tick -- ticks
 * its own local interval, isolated in this small component, instead of the
 * top-level `now` state that used to force the entire message list to
 * re-render every 5s for this one card's sake.
 */
function ExpiryCountdownText({ expiresAt }: { expiresAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const countdown = expiryCountdown(expiresAt, nowMs);
  if (!countdown) return null;
  return <span className="wf-chat-approval-card-countdown ol-mono">{countdown}</span>;
}

/** An approval card's resolved state -- same card, same spot, just no longer
 * asking anything. Replaces the actionable card in place once a decision is
 * recorded (see resolvedCards above), instead of the card vanishing with no
 * visible trace of what was decided or by whom. */
function ResolvedApprovalCard({ record, nowMs }: { record: { label: string; outcome: "approved" | "neutral"; decidedAt: number }; nowMs: number | null }) {
  return (
    <div className="wf-chat-approval-card wf-chat-approval-card--resolved" data-outcome={record.outcome} role="status">
      <span className="wf-chat-approval-card-dot" aria-hidden />
      <span>{record.label}</span>
      <span className="wf-chat-approval-card-resolved-time ol-mono">by You · {relativeTime(new Date(record.decidedAt).toISOString(), nowMs)}</span>
    </div>
  );
}

const STEP_STATUS_LABEL: Record<WorkspaceStep["status"], string> = { started: "…", waiting: "…", succeeded: "✓", failed: "✕" };

/** Same idiom as STEP_STATUS_LABEL above -- a glyph per state, no color
 * carrying meaning on its own. ACP's plan vocabulary has no failure state
 * (PlanEntryStatus is pending | in_progress | completed), so nothing here
 * is ever tinted as danger: an in-progress item is normal work, not a
 * problem, and the turn's own failure is already reported by the liveness
 * line and the result message's outcome. */
const TODO_STATUS_GLYPH: Record<MessageTodo["entries"][number]["status"], string> = { completed: "✓", in_progress: "✱", pending: "○" };

/**
 * The checklist rendered INSIDE an agent's message bubble -- the compact,
 * evolving todo list, deliberately not the step log (StepGroupCard above,
 * which stays exactly as it was: a different feature, the full activity
 * feed). This is one small ordered list plus a "todos as of <time>" stamp,
 * the way one evolving message reads rather than a stream of status posts.
 */
function MessageTodoList({ todo, label, nowMs }: { todo: MessageTodo; label: string | null; nowMs: number | null }) {
  const done = todo.entries.filter((entry) => entry.status === "completed").length;
  return (
    <div className="wf-chat-todos" role="group" aria-label={label ? `${label} checklist` : "Agent checklist"}>
      <ol className="wf-chat-todo-list">
        {todo.entries.map((entry, index) => (
          <li key={`${index}-${entry.content}`} data-todo-status={entry.status}>
            <span className="wf-chat-todo-glyph ol-mono" aria-hidden>{TODO_STATUS_GLYPH[entry.status]}</span>
            <span className="wf-chat-todo-content">{entry.content}</span>
          </li>
        ))}
      </ol>
      <p className="wf-chat-todo-footer">
        {label && <span className="wf-chat-todo-footer-name">{label}</span>}
        <span className="ol-mono">{done}/{todo.entries.length}</span>
        <span>todos as of {relativeTime(todo.updated_at, nowMs)}</span>
      </p>
    </div>
  );
}

/**
 * A-6: one collapsible entry per turn, defaulting open while any of its
 * steps are still in progress -- a global expand/collapse mode per
 * Nielsen's two-level rule (see the research doc), not a per-step
 * accordion. Once a turn settles this stops forcing itself open but does
 * not auto-collapse either -- a human who had it open to read a step
 * should not have it yanked shut out from under them the instant the
 * reply lands. A failed step is a distinct, visibly marked entry
 * (STEP_STATUS_LABEL's "✕"), never silently folded into a generic
 * success tint.
 */
/**
 * B-4: verbosity is a global mode (Nielsen's two-level rule -- one control
 * for the whole feed, not a per-row accordion each card reinvents), but a
 * human's own manual expand/collapse on a specific card still wins once
 * they've touched it -- switching modes only resets that override, it
 * doesn't fight a click the human just made.
 */
function StepGroupCard({ group, label, verbosity }: { group: { messageId: string; steps: WorkspaceStep[]; inProgress: boolean }; label: string; verbosity: TranscriptVerbosity }) {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  useEffect(() => {
    // Reset the manual override when the global verbosity mode changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManualExpanded(null);
  }, [verbosity]);
  const modeDefault = verbosity === "verbose" ? true : verbosity === "summary" ? false : group.inProgress;
  const expanded = manualExpanded ?? modeDefault;
  return (
    // Real bug fixed here: this was a <li>, but its one real call site
    // renders it INSIDE a message's own <li> (a normal block of that
    // message's content, not a sibling list item) -- confirmed live, this
    // produced a genuine <li>-in-<li> hydration error that made React bail
    // on the whole subtree. A <div> carries the exact same
    // .wf-chat-activity-card/.wf-chat-step-group styling with none of the
    // invalid-nesting problem; this component has no other call site.
    <div className="wf-chat-activity-card wf-chat-step-group" data-in-progress={group.inProgress}>
      <button type="button" className="wf-chat-step-group-toggle" onClick={() => setManualExpanded(!expanded)} aria-expanded={expanded}>
        <span className="wf-chat-activity-dot" aria-hidden />
        <strong>{label}</strong>
        <small>{group.steps.length} step{group.steps.length === 1 ? "" : "s"}{group.inProgress ? " · in progress" : ""}</small>
      </button>
      {expanded && (
        <ol className="wf-chat-step-list">
          {group.steps.map((step) => (
            <li key={step.stepId} data-step-status={step.status}>
              <span className="ol-mono">{STEP_STATUS_LABEL[step.status]}</span> {step.summary}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Drag-to-resize for a grid-column panel (Files / Ready for Review / Live
 * Code), the same idiom Claude Code's own terminal UI uses for its side
 * panels -- a real draggable divider, not a fixed width. Width lives in a
 * CSS custom property (set on the shell's inline style) rather than React
 * state driving layout directly, so a drag updates the DOM every pointermove
 * without re-rendering the whole chat tree on every pixel.
 *
 * Pointer capture on the handle itself means move/up keep firing even if the
 * cursor leaves the thin handle during a fast drag -- no window-level
 * listeners needed. Arrow-key support on the same element keeps it a real
 * accessible separator, not just a mouse toy.
 */
function usePanelResizer(storageKey: string, defaultPx: number, min: number, max: number) {
  const [width, setWidth] = useState(defaultPx);
  const widthRef = useRef(defaultPx);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      const parsed = stored ? Number(stored) : NaN;
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(max, Math.max(min, parsed));
        widthRef.current = clamped;
        // This effect hydrates a browser-local layout preference after SSR.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setWidth(clamped);
      }
      // Re-read only when the storage key or its bounds genuinely change.
    } catch { /* localStorage can throw in a private/locked-down browser -- default stands */ }
  }, [storageKey, min, max]);

  function commit(next: number) {
    const clamped = Math.min(max, Math.max(min, next));
    widthRef.current = clamped;
    setWidth(clamped);
    try { window.localStorage.setItem(storageKey, String(clamped)); } catch { /* best-effort */ }
  }

  const handleProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-valuenow": Math.round(width),
    "aria-valuemin": min,
    "aria-valuemax": max,
    tabIndex: 0,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: widthRef.current };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      // The panel sits to the right of the divider, so dragging left
      // (negative clientX delta) grows it -- delta is start minus current.
      const delta = dragRef.current.startX - event.clientX;
      const next = Math.min(max, Math.max(min, dragRef.current.startWidth + delta));
      widthRef.current = next;
      setWidth(next);
    },
    onPointerUp: () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try { window.localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* best-effort */ }
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const STEP = 24;
      if (event.key === "ArrowLeft") { event.preventDefault(); commit(widthRef.current + STEP); }
      else if (event.key === "ArrowRight") { event.preventDefault(); commit(widthRef.current - STEP); }
    },
  };

  return { width, handleProps };
}

function PanelResizeHandle({ label, handleProps }: { label: string; handleProps: ReturnType<typeof usePanelResizer>["handleProps"] }) {
  return <div className="wf-panel-resizer" aria-label={`Resize ${label} panel`} {...handleProps} />;
}

/** Workspace-first channel surface. Agents are already members; Missions are optional context. */
/** `mainOverlay` takes over the feed column while something else is being
 * read in it (B1: a promoted file diff). The panel stays mounted underneath
 * on purpose -- it owns the relay subscription that feeds live steps and the
 * unsent draft, and unmounting it to show a diff would drop both. */
export default function ConversationPanel({ agents, workspaceId, viewerUserId, onFileStep, sidePanel, mainOverlay, filePanel, onOpenReview, reviewActive, pendingReviewCount, onOpenWhispers, whispersActive, onOpenDrafts, draftsActive, onOpenPeople, peopleActive, onOpenLive, liveActive, onOpenHandoffs, handoffsActive }: { agents: AgentView[]; workspaceId: string | null; viewerUserId: string | null; onFileStep?: (step: WorkspaceStep) => void; sidePanel?: ReactNode; mainOverlay?: ReactNode; filePanel?: ReactNode; onOpenReview?: () => void; reviewActive?: boolean; pendingReviewCount?: number; onOpenWhispers?: () => void; whispersActive?: boolean; onOpenDrafts?: () => void; draftsActive?: boolean; onOpenPeople?: () => void; peopleActive?: boolean; onOpenLive?: () => void; liveActive?: boolean; onOpenHandoffs?: () => void; handoffsActive?: boolean }) {
  // Drag-to-resize widths for the two right-hand panel slots -- one storage
  // key per slot, shared across whichever content currently occupies it
  // (Files vs. Ready for Review both use the side slot, so they share one
  // remembered width rather than jumping every time you switch between them).
  const sidePanelResize = usePanelResizer("ol-side-panel-width", 320, 220, 480);
  const filePanelResize = usePanelResizer("ol-file-panel-width", 640, 360, 1000);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [draft, setDraft] = useState("");
  const [routeSuggestionDismissed, setRouteSuggestionDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  // Server-side count, not notifications.filter(!read_at) -- `notifications`
  // is only the most recent 100 rows, so counting it undercounts the badge.
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [pendingTaskContracts, setPendingTaskContracts] = useState<TaskCardContract[]>([]);
  const [pendingEvidenceRequests, setPendingEvidenceRequests] = useState<PendingEvidenceRequest[]>([]);
  const [evidenceDecisionBusyId, setEvidenceDecisionBusyId] = useState<string | null>(null);
  const [pendingRunStartApprovals, setPendingRunStartApprovals] = useState<PendingRunStartApproval[]>([]);
  const [runStartDecisionBusyId, setRunStartDecisionBusyId] = useState<string | null>(null);
  // A human's click and the 5s poller both mutate these lists. Filtering poll
  // results through the ids decided locally -- rather than optimistically
  // splicing the list and letting the next poll response overwrite that splice
  // wholesale -- is what stops a just-decided card from reappearing when a
  // poll that was already in flight lands a moment later.
  /**
   * Claude Tag's own video (docs/research-claude-tag-ui-deep-dive.md) shows
   * one message editing in place as work progresses, never a fresh post per
   * status change. OathLock's approval cards had the opposite problem: on
   * decision the card just vanished from the DOM (evidenceRequestByMessageId
   * etc. drop the id the instant it's decided, both optimistically and once
   * the poller's server response stops including it), leaving zero visible
   * record unless a human happened to type "Approved" as a separate message.
   * This snapshots the outcome, keyed by the request's own announcement
   * message id, so the SAME card can render its resolved state in place
   * instead of disappearing -- the same "one evolving surface" principle,
   * applied to a feature (a human approval gate) Claude Tag doesn't have.
   */
  const [resolvedCards, setResolvedCards] = useState<Record<string, { label: string; outcome: "approved" | "neutral"; decidedAt: number }>>({});
  const [decidedEvidenceRequestIds, setDecidedEvidenceRequestIds] = useState<Set<string>>(new Set());
  const [decidedRunStartApprovalIds, setDecidedRunStartApprovalIds] = useState<Set<string>>(new Set());
  const [pendingFindings, setPendingFindings] = useState<PendingFinding[]>([]);
  const [findingDecisionBusyId, setFindingDecisionBusyId] = useState<string | null>(null);
  const [decidedFindingIds, setDecidedFindingIds] = useState<Set<string>>(new Set());
  const [pendingRuleDrafts, setPendingRuleDrafts] = useState<PendingRuleDraft[]>([]);
  const [ruleDraftDecisionBusyId, setRuleDraftDecisionBusyId] = useState<string | null>(null);
  const [decidedRuleDraftIds, setDecidedRuleDraftIds] = useState<Set<string>>(new Set());
  const [pendingPermissions, setPendingPermissions] = useState<PendingBridgePermission[]>([]);
  const [permissionDecisionBusyId, setPermissionDecisionBusyId] = useState<string | null>(null);
  const [decidedPermissionIds, setDecidedPermissionIds] = useState<Set<string>>(new Set());
  const [pendingEvidenceSubmissions, setPendingEvidenceSubmissions] = useState<PendingEvidenceSubmission[]>([]);
  const [evidenceSubmissionDecisionBusyId, setEvidenceSubmissionDecisionBusyId] = useState<string | null>(null);
  const [decidedEvidenceSubmissionIds, setDecidedEvidenceSubmissionIds] = useState<Set<string>>(new Set());
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [verbosity, setVerbosity] = useState<TranscriptVerbosity>("normal");
  const [verbosityMenuOpen, setVerbosityMenuOpen] = useState(false);
  const verbosityMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!verbosityMenuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (verbosityMenuRef.current && !verbosityMenuRef.current.contains(event.target as Node)) setVerbosityMenuOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setVerbosityMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [verbosityMenuOpen]);
  const [confirmDeleteMessageTarget, setConfirmDeleteMessageTarget] = useState<ConversationMessage | null>(null);
  const [deletingMessage, setDeletingMessage] = useState(false);
  /**
   * D2: an unread divider needs the read cursor from the *moment a channel
   * is opened*, not the live unread_count -- markRead() below optimistically
   * zeroes that count almost immediately, so by paint time there'd be
   * nothing left to anchor a divider to. Snapshotting the first unread
   * message's id (not a count/offset) keeps the divider pinned to that
   * exact message even if new ones arrive and grow the list while the
   * channel stays open.
   */
  const [unreadBoundary, setUnreadBoundary] = useState<{ conversationId: string; messageId: string } | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [relayStatus, setRelayStatus] = useState<BrowserMissionRelayStatus>("idle");
  const [relayErrorMessage, setRelayErrorMessage] = useState<string | null>(null);
  const [relayHttpFallback, setRelayHttpFallback] = useState(false);
  const [typingParticipantIds, setTypingParticipantIds] = useState<string[]>([]);
  /** Shared Live Sessions: who else has this channel open right now. The
   * relay's presence tracking (send + server-side rebroadcast) already
   * fully existed -- WorkspaceRelayBrowserClient.setPresence("online") is
   * already called on connect below -- the only missing piece was that
   * incoming participant.presence frames were discarded instead of read.
   * Channel-scoped rather than per-turn: a channel can have two agents
   * running at once and this deliberately doesn't try to say which one a
   * given human is watching, just that they're here. */
  const [onlineParticipantIds, setOnlineParticipantIds] = useState<string[]>([]);
  const [channelRoster, setChannelRoster] = useState<Map<string, string>>(new Map());
  /** Shared Live Sessions: messageIds the bridge confirmed are sitting
   * behind another turn already running/queued for that session -- see
   * mission-relay-client.ts's postQueuedNotice doc comment for why this
   * exists (a queued message used to look identical to one about to run
   * immediately). Cleared once that message's own turn actually starts
   * (its first workspace.step/workspace.turn arrives), not on a timer --
   * "queued" is true for exactly as long as it's true. */
  const [queuedMessageIds, setQueuedMessageIds] = useState<Set<string>>(new Set());
  // A-2: corrected after live testing found `participant.typing` is only
  // ever emitted from the human side of this same composer (grep confirmed
  // `setTyping(true)` has exactly one caller, below) -- it can never fire
  // for an agent actually working, so it cannot drive an agent liveness
  // line. The signal that replaced it, a regex on the outgoing message, was
  // no better: it started an indicator with nothing behind it and stopped it
  // on a 5-minute timer. This map is now driven by the Bridge's own
  // `workspace.turn` frames (bridge-runtime.ts's runQueuedPrompts) and the
  // real per-step activity for the same connection, keyed per agent so
  // concurrent turns don't overwrite each other.
  const [agentTurns, setAgentTurns] = useState<Record<string, AgentTurnState>>({});
  // Read inside the relay effect below (deps [workspaceId, selectedId], not
  // re-run per render) via a ref so a new onFileStep identity on a parent
  // re-render is picked up without tearing down and reconnecting the socket.
  const onFileStepRef = useRef(onFileStep);
  useEffect(() => { onFileStepRef.current = onFileStep; }, [onFileStep]);
  const [cancelingConnectionIds, setCancelingConnectionIds] = useState<string[]>([]);
  /** Set once a Stop is actually delivered (not just clicked) -- opens the
   * same interject window the bridge holds open on its own side (see
   * INTERJECT_WINDOW_MS in bridge-runtime.ts) so the composer visibly
   * invites whoever's in the channel, not just whoever clicked Stop, to add
   * what should happen instead before the next turn just starts on its own. */
  const [interjectFor, setInterjectFor] = useState<{ connectionId: string; label: string } | null>(null);
  useEffect(() => {
    if (!interjectFor) return;
    const timer = window.setTimeout(() => setInterjectFor(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [interjectFor]);
  /** The clock the turn indicator's two time-based rules are evaluated
   * against, advanced only from a timer at the exact moment a deadline comes
   * due (see visibleTurns). Reading it instead of Date.now() keeps that
   * derivation pure; a stale value can only ever keep an indicator up a
   * moment longer, never retire one early. */
  const [turnClockMs, setTurnClockMs] = useState(0);
  const [liveActivity, setLiveActivity] = useState<Array<{ id: string; summary: string; occurred_at?: string; activity?: Record<string, unknown> | null }>>([]);
  const [workspaceSteps, setWorkspaceSteps] = useState<WorkspaceStep[]>([]);
  /**
   * Live checklist revisions off the `workspace.todos` relay frame, keyed
   * `messageId:connectionId` -- the same identity the durable row uses.
   * Held apart from the message list on purpose: a message re-delivered by
   * the relay (mergeConversationMessages replaces wholesale) carries no
   * todos on the wire, and folding live state into it would let a routine
   * re-merge blank a checklist a human is reading. */
  const [liveTodos, setLiveTodos] = useState<Record<string, MessageTodo>>({});
  const relayRef = useRef<WorkspaceRelayBrowserClient | null>(null);
  /**
   * The chat ⇄ terminal toggle from item 21's spec: a view on this same
   * channel, not a separate page, so it's local component state rather than
   * threaded through AgentWorkspaceClient's sidePanelMode the way
   * Files/Review/etc. are -- those show alongside chat; this replaces it,
   * and only ConversationPanel has the relay connection terminal frames ride.
   */
  const [terminalRequested, setTerminalActive] = useState(false);
  /**
   * TERMINAL_ENABLED is the kill switch, applied here rather than only on the
   * toggle button, so stale state or a future caller can never put the
   * unfinished view on screen while the flag is off.
   */
  const terminalActive = TERMINAL_ENABLED && terminalRequested;
  /** Raw session facts as the relay reports them -- isOwner/ownerLabel are per-viewer, computed at render time in ptyRoomSessions below, not stored here. */
  const [ptySessions, setPtySessions] = useState<Record<string, Omit<PtyRoomSession, "isOwner" | "ownerLabel">>>({});
  /** Captured once the relay authenticates, so a pane can tell "am I the owner" apart from "someone else is." State, not a ref -- ptyRoomSessions reads it during render, and reading a ref there is a real correctness bug (React may render without committing). */
  const [viewerParticipantId, setViewerParticipantId] = useState<string | null>(null);
  /**
   * pty.output/input/resize/state all fan through the single onFrame handler
   * below (same socket chat, presence, and steps already use -- a second
   * connection per pane would double the Relay's per-connection auth and
   * heartbeat cost). Mounted TerminalPane instances subscribe here instead of
   * each opening their own socket.
   */
  const ptyFrameListenersRef = useRef(new Set<(frame: RelayFrame) => void>());
  const subscribePtyFrames = useCallback((listener: (frame: RelayFrame) => void) => {
    ptyFrameListenersRef.current.add(listener);
    return () => { ptyFrameListenersRef.current.delete(listener); };
  }, []);
  const sendTerminalFrame = useCallback((type: "pty.input" | "pty.resize" | "pty.close" | "pty.share" | "pty.request" | "pty.link" | "pty.unlink" | "presence.cursor" | "participant.typing", payload: Record<string, unknown>) => {
    return relayRef.current?.sendTerminalFrame(type, payload) ?? false;
  }, []);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionHighlightRef = useRef<HTMLDivElement | null>(null);
  const messagesListRef = useRef<HTMLOListElement | null>(null);
  const searchParams = useSearchParams();
  // Read reactively (not captured once at mount): a deep link's ?message=
  // must re-arm on a client-side navigation too -- e.g. clicking "Join" on
  // a Live Sessions row while already inside the app changes the URL via
  // router.replace, which does not remount this component, so a value
  // captured only once at mount would never see the new target. Source:
  // /dashboard/approvals/[id] redirects here, and Live Sessions "Join" links
  // here the same way.
  const deepLinkConversationId = searchParams.get("conversation");
  const deepLinkMessageId = searchParams.get("message");
  // Tracks the last deep link actually scrolled to, so a *repeat* of the
  // same link doesn't re-scroll/re-highlight on every render, while a *new*
  // one (different conversation+message pair) still fires.
  const consumedDeepLinkKeyRef = useRef<string | null>(null);
  const router = useRouter();
  // Which channel is open is URL state (?conversation=), because the list that
  // switches it now lives in the primary nav (ProductShell) rather than in
  // this component -- same reason agent selection travels as ?agent=.
  const selectedId = searchParams.get("conversation");
  useComposerAutosize(textareaRef, draft, `${selectedId}:${showInbox}:${terminalActive}:${Boolean(mainOverlay)}`);
  function selectConversation(conversationId: string) {
    router.replace(channelHref(conversationId), { scroll: false });
  }
  useEffect(() => {
    if (!selectedId) {
      // Clear channel-scoped labels when navigation leaves a conversation.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChannelRoster(new Map());
      return;
    }
    let cancelled = false;
    fetch(`/api/dashboard/conversations/${encodeURIComponent(selectedId)}/members`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { roster?: Array<{ userId: string; email: string | null }> }) => {
        if (cancelled) return;
        setChannelRoster(new Map((data.roster ?? []).map((row) => [row.userId, row.email ?? row.userId])));
      })
      .catch(() => { /* best-effort label lookup -- presence still shows a generic label without it */ });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Extracted so the channel switcher/create-channel dialog can trigger an
  // immediate refresh after creating or leaving a channel, instead of
  // waiting for the next 8-30s poll tick to notice.
  const loadSeqRef = useRef(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const loadConversations = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const requestedFor = selectedId;
    try {
      // Only the open channel needs its full message history from this
      // endpoint (see the route's own comment) -- everyone else is a
      // preview-line read.
      const url = selectedId ? `/api/dashboard/conversations?selected=${encodeURIComponent(selectedId)}` : "/api/dashboard/conversations";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations?: Conversation[] };
      // A newer load (or a channel switch) superseded this one: applying it
      // would snap the UI back to the channel that was open when it started.
      if (seq !== loadSeqRef.current) return;
      const incoming = data.conversations ?? [];
      const current = selectedIdRef.current;
      setConversations((previous) => incoming.map((conversation) => {
        // This response carried only a preview line for the channel the user
        // has since opened; keep the history already loaded for it.
        if (conversation.id === current && requestedFor !== current) {
          const existing = previous.find((candidate) => candidate.id === conversation.id);
          if (existing && existing.messages.length > conversation.messages.length) {
            return { ...conversation, messages: existing.messages };
          }
        }
        return conversation;
      }));
    } catch {
      setNotice("Channels are temporarily unavailable.");
    }
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (cancelled) return;
      await loadConversations();
    }
    void load();
    // Normal human and bridge-owned agent messages arrive through the live
    // workspace relay and merge immediately. Keep a slower HTTP refresh as a
    // durable fallback for direct API writers and reconnect gaps; use the
    // faster cadence only while the relay is unavailable.
    // The live relay is still the primary sync path, but agent MCP replies
    // are written by a stateless API route and may miss the relay during a
    // restart. Keep the durable fallback under ten seconds so a missed live
    // event never looks like a silent reply for half a minute.
    const intervalMs = relayStatus === "subscribed" ? 10_000 : 8_000;
    const id = window.setInterval(() => void load(), intervalMs);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [relayStatus, loadConversations]);

  useEffect(() => {
    relayRef.current?.close();
    relayRef.current = null;
    let cancelled = false;
    const resetId = window.setTimeout(() => {
      if (cancelled) return;
      setRelayHttpFallback(false);
      setRelayStatus(workspaceId && selectedId ? "connecting" : "idle");
      setRelayErrorMessage(null);
      setLiveActivity([]);
      setOnlineParticipantIds([]);
      setTypingParticipantIds([]);
      // Turn state is per-channel and live-only: what another channel's
      // agents are doing is not knowable from here, and re-subscribing
      // replays no history for it (see mission-relay-service.ts's
      // workspace.turn case).
      setAgentTurns({});
      setWorkspaceSteps([]);
      setLiveTodos({});
      // Sessions are scoped to the channel whose room they were opened in --
      // stale entries from a previous channel would otherwise render dead
      // panes (or worse, a session id that now belongs to a different room).
      setPtySessions({});
      setTerminalActive(false);
    }, 0);
    if (!workspaceId || !selectedId) return () => { cancelled = true; window.clearTimeout(resetId); };
    type RelayCredentialResponse = { relayUrl?: string; workspaceId?: string; participantId?: string; token?: string; code?: string };
    const fetchRelayCredential = async (): Promise<RelayCredentialResponse> => {
      const response = await fetch(`/api/missions/relay-token?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as RelayCredentialResponse;
      if (!response.ok || !body.relayUrl || !body.workspaceId || !body.token) {
        // A deployment with no live relay configured (or the feature simply
        // disabled) is not a connection error -- chat still fully works over
        // the HTTP fallback below. Only an unexpected failure after the
        // relay claims to be available should read as "connection issue".
        const notConfigured = body.code === "backend_not_configured" || body.code === "conflict";
        throw new Error(notConfigured ? "relay-not-configured" : "Live workspace relay is unavailable.");
      }
      return body;
    };
    const clientPromise = fetchRelayCredential()
      .then(async (body) => {
        if (cancelled) return;
        setViewerParticipantId(body.participantId ?? null);
        const client = new WorkspaceRelayBrowserClient({
          url: body.relayUrl!, workspaceId: body.workspaceId!, channelId: selectedId!,
          // Relay credentials intentionally expire quickly. Supplying only
          // the first token made an otherwise healthy dashboard fail on the
          // next reconnect with "credential invalid or expired". Fetch a
          // fresh credential for every authentication attempt instead.
          getCredential: async () => (await fetchRelayCredential()).token!,
          participantId: body.participantId,
          onStatus: (status, detail) => { if (!cancelled) { setRelayHttpFallback(false); setRelayStatus(status); setRelayErrorMessage(status === "error" ? detail ?? "Workspace relay connection failed." : null); } },
          onSnapshot: (snapshot) => {
            if (cancelled) return;
            const messages = Array.isArray(snapshot.messages) ? (snapshot.messages as ConversationMessage[]).map(normalizeIncomingMessage) : [];
            const incremental = snapshot.incremental === true;
            if (messages.length > 0) setConversations((current) => current.map((conversation) => conversation.id !== selectedId ? conversation : { ...conversation, messages: incremental ? mergeConversationMessages(conversation.messages, messages) : messages, unread_count: 0 }));
            const activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
            setLiveActivity(activity.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const value = item as { id?: unknown; event_type?: unknown; summary?: unknown; occurred_at?: unknown; activity?: unknown };
              return typeof value.id === "string" && typeof value.summary === "string" ? [{ id: value.id, summary: value.summary, occurred_at: typeof value.occurred_at === "string" ? value.occurred_at : undefined, activity: value.activity && typeof value.activity === "object" ? value.activity as Record<string, unknown> : null }] : [];
            }));
          },
          onFrame: (frame: RelayFrame) => {
            if (cancelled) return;
            // Terminal presence rides the same channel socket as chat
            // presence. Forward both cosmetic frame types to pane listeners
            // before the chat-only typing projection consumes its copy;
            // otherwise the chat branch's return strands terminal tags, and
            // cursor frames never reach TerminalPane at all.
            if (frame.type === "participant.typing" || frame.type === "presence.cursor") {
              for (const listener of ptyFrameListenersRef.current) listener(frame);
              if (frame.type === "presence.cursor") return;
            }
            if (frame.type.startsWith("pty.")) {
              if (frame.type === "pty.state") {
                const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { sessionId?: unknown; status?: unknown; title?: unknown; ownerParticipantId?: unknown; shared?: unknown; linkedSessionIds?: unknown } : {};
                if (typeof payload.sessionId === "string") {
                  const sessionId = payload.sessionId;
                  setPtySessions((current) => {
                    if (payload.status === "exited") {
                      if (!(sessionId in current)) return current;
                      const next = { ...current };
                      delete next[sessionId];
                      return next;
                    }
                    return {
                      ...current,
                      [sessionId]: {
                        sessionId,
                        status: "running",
                        title: typeof payload.title === "string" ? payload.title : current[sessionId]?.title,
                        ownerParticipantId: typeof payload.ownerParticipantId === "string" ? payload.ownerParticipantId : current[sessionId]?.ownerParticipantId ?? "",
                        shared: typeof payload.shared === "boolean" ? payload.shared : current[sessionId]?.shared ?? true,
                        linkedSessionIds: Array.isArray(payload.linkedSessionIds) ? payload.linkedSessionIds.filter((id): id is string => typeof id === "string") : current[sessionId]?.linkedSessionIds ?? [],
                      },
                    };
                  });
                }
              }
              for (const listener of ptyFrameListenersRef.current) listener(frame);
              return;
            }
            if (frame.type === "participant.typing") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { participantId?: unknown; typing?: unknown; expiresAt?: unknown } : {};
              if (typeof payload.participantId !== "string" || payload.participantId === body.participantId) return;
              const participantId = payload.participantId;
              setTypingParticipantIds((current) => payload.typing === true ? [...new Set([...current, participantId])] : current.filter((id) => id !== participantId));
              return;
            }
            if (frame.type === "participant.presence") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { participantId?: unknown; state?: unknown } : {};
              if (typeof payload.participantId !== "string" || payload.participantId === body.participantId) return;
              const participantId = payload.participantId;
              const online = payload.state === "online" || payload.state === "working";
              setOnlineParticipantIds((current) => online ? [...new Set([...current, participantId])] : current.filter((id) => id !== participantId));
              return;
            }
            if (frame.type === "workspace.queued") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { messageId?: unknown } : {};
              if (typeof payload.messageId !== "string") return;
              const messageId = payload.messageId;
              setQueuedMessageIds((current) => new Set(current).add(messageId));
              return;
            }
            if (frame.type === "workspace.event") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { message?: ConversationMessage; activity?: { id?: string; summary?: string; occurred_at?: string; activity?: Record<string, unknown> | null } } : {};
              if (payload.message) setConversations((current) => current.map((conversation) => conversation.id !== selectedId ? conversation : { ...conversation, messages: mergeConversationMessages(conversation.messages, [normalizeIncomingMessage(payload.message!)]) }));
              if (payload.activity?.id && payload.activity.summary) {
                const activity = { id: payload.activity.id, summary: payload.activity.summary, occurred_at: payload.activity.occurred_at, activity: payload.activity.activity };
                setLiveActivity((current) => [activity, ...current.filter((item) => item.id !== activity.id)].slice(0, 80));
              }
              return;
            }
            if (frame.type === "workspace.step") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { messageId?: unknown; connectionId?: unknown; stepId?: unknown; kind?: unknown; status?: unknown; summary?: unknown; filePath?: unknown; command?: unknown; activityId?: unknown; additions?: unknown; deletions?: unknown } : {};
              if (typeof payload.messageId !== "string" || typeof payload.stepId !== "string" || typeof payload.summary !== "string") return;
              // A real step for this message is proof its turn actually
              // started -- "queued" was only ever true up to that point.
              setQueuedMessageIds((current) => {
                if (!current.has(payload.messageId as string)) return current;
                const next = new Set(current);
                next.delete(payload.messageId as string);
                return next;
              });
              const step: WorkspaceStep = {
                stepId: payload.stepId,
                messageId: payload.messageId,
                connectionId: typeof payload.connectionId === "string" ? payload.connectionId : null,
                kind: typeof payload.kind === "string" ? payload.kind : "unknown",
                status: payload.status === "succeeded" || payload.status === "failed" || payload.status === "waiting" ? payload.status : "started",
                summary: payload.summary,
                filePath: typeof payload.filePath === "string" ? payload.filePath : null,
                command: typeof payload.command === "string" ? payload.command : null,
                receivedAtMs: Date.now(),
                activityId: typeof payload.activityId === "string" ? payload.activityId : null,
                additions: typeof payload.additions === "number" ? payload.additions : null,
                deletions: typeof payload.deletions === "number" ? payload.deletions : null,
              };
              // Bounded, not because steps are expected to flood -- a stuck
              // or looping turn must never grow this without limit.
              setWorkspaceSteps((current) => current.some((item) => item.stepId === step.stepId) ? current : [...current, step].slice(-300));
              if (step.filePath) onFileStepRef.current?.(step);
              // A step is itself proof the turn is live, so it both feeds the
              // indicator's text and confirms the turn -- a dropped
              // `workspace.turn` "started" (best-effort, live-only) can never
              // leave a genuinely working agent showing as unconfirmed.
              if (step.connectionId) {
                const connectionId = step.connectionId;
                setAgentTurns((current) => {
                  const existing = current[connectionId];
                  return {
                    ...current,
                    [connectionId]: {
                      connectionId,
                      startedAtMs: existing && !existing.ended ? existing.startedAtMs : step.receivedAtMs,
                      confirmed: true,
                      messageId: step.messageId,
                      action: { kind: step.kind, status: step.status, summary: step.summary, filePath: step.filePath, command: step.command },
                      ended: null,
                    },
                  };
                });
              }
              return;
            }
            if (frame.type === "workspace.todos") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { messageId?: unknown; connectionId?: unknown; entries?: unknown; updatedAt?: unknown } : {};
              if (typeof payload.messageId !== "string" || typeof payload.connectionId !== "string" || !Array.isArray(payload.entries)) return;
              const entries = payload.entries.flatMap((raw) => {
                if (!raw || typeof raw !== "object") return [];
                const entry = raw as { content?: unknown; status?: unknown; priority?: unknown };
                if (typeof entry.content !== "string" || !entry.content.trim()) return [];
                const status = entry.status === "in_progress" || entry.status === "completed" || entry.status === "pending" ? entry.status : null;
                if (!status) return [];
                const priority = entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium" as const;
                return [{ content: entry.content.slice(0, 240), status, priority } as MessageTodo["entries"][number]];
              });
              // An empty or unusable frame is dropped rather than applied:
              // blanking a checklist a human is reading over a malformed
              // payload is strictly worse than showing a slightly stale one.
              if (entries.length === 0) return;
              const todo: MessageTodo = {
                message_id: payload.messageId,
                connection_id: payload.connectionId,
                entries,
                updated_at: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString(),
              };
              setLiveTodos((current) => ({ ...current, [`${todo.message_id}:${todo.connection_id}`]: todo }));
              return;
            }
            if (frame.type === "workspace.turn") {
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { messageId?: unknown; connectionId?: unknown; state?: unknown; outcome?: unknown; detail?: unknown } : {};
              if (typeof payload.connectionId !== "string") return;
              const connectionId = payload.connectionId;
              const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
              if (payload.state === "started") {
                setAgentTurns((current) => {
                  const existing = current[connectionId];
                  return {
                    ...current,
                    [connectionId]: {
                      connectionId,
                      // Keep the optimistic clock when this confirms a turn
                      // the composer already started counting, so the elapsed
                      // time doesn't visibly jump backwards on confirmation.
                      startedAtMs: existing && !existing.ended ? existing.startedAtMs : Date.now(),
                      confirmed: true,
                      messageId,
                      action: existing && !existing.ended ? existing.action : null,
                      ended: null,
                    },
                  };
                });
                return;
              }
              if (payload.state !== "ended") return;
              const outcome = payload.outcome === "failed" || payload.outcome === "cancelled" || payload.outcome === "incomplete" ? payload.outcome : "ok";
              setAgentTurns((current) => {
                const existing = current[connectionId];
                // A clean finish needs no terminal line: the agent's reply is
                // already landing in the transcript behind it.
                if (outcome === "ok") {
                  if (!existing) return current;
                  const next = { ...current };
                  delete next[connectionId];
                  return next;
                }
                const base: AgentTurnState = existing ?? { connectionId, startedAtMs: Date.now(), confirmed: true, messageId, action: null, ended: null };
                return { ...current, [connectionId]: { ...base, ended: { outcome, detail: typeof payload.detail === "string" ? payload.detail : null, atMs: Date.now() } } };
              });
              return;
            }
          },
        });
        relayRef.current = client;
        await client.connect();
        await client.setPresence("online");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const notConfigured = err instanceof Error && err.message === "relay-not-configured";
        // HTTP polling remains the durable source of truth for both an
        // intentionally disabled relay and a transient/authentication failure.
        // Keep the channel usable while still exposing the relay error in the
        // status copy instead of leaving the user with a dead chat surface.
        setRelayHttpFallback(true);
        setRelayStatus(notConfigured ? "closed" : "error");
        setRelayErrorMessage(notConfigured ? null : err instanceof Error ? err.message : "Workspace relay connection failed.");
      });
    void clientPromise;
    return () => { cancelled = true; window.clearTimeout(resetId); if (typingTimerRef.current) clearTimeout(typingTimerRef.current); relayRef.current?.close(); relayRef.current = null; };
  }, [workspaceId, selectedId]);

  // A-5: this used to tick every 5s and re-render the entire message list --
  // 1,694 lines' worth of JSX -- for the sake of a handful of clock-derived
  // strings. `now` only genuinely needs to be non-null (it started as a
  // hydration guard: the server can't know the client's clock, so this
  // stays null through SSR and gets set once after mount). Nothing that
  // reads `now` below (absoluteTime, dayLabel, the small liveActivity
  // list's relativeTime) needs sub-minute freshness, and each already
  // re-renders naturally whenever its own underlying data changes. The one
  // place that genuinely needs a live per-second tick -- the run-start
  // approval card's expiry countdown -- now manages that itself, isolated
  // in its own component (ExpiryCountdownText below), instead of forcing
  // it on everything else.
  useEffect(() => {
    const id = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);

  /**
   * A-4: one poller replacing what used to be seven independent, unsynced
   * 5s intervals (one per decision type), each its own network round trip
   * and its own DB query. The combined /api/dashboard/pending-decisions
   * endpoint runs the same seven underlying queries server-side via
   * Promise.all -- this only consolidates the transport, not the data. Side
   * benefit noted in the research doc: this is also one interval to tear
   * down/recreate on a decision, not seven.
   */
  useEffect(() => {
    let cancelled = false;
    async function loadPendingDecisions() {
      try {
        const res = await fetch("/api/dashboard/pending-decisions", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          notifications?: NotificationItem[];
          unreadNotificationCount?: number;
          requests?: Array<{ id: string; conversationId: string; agentConnectionId: string; provider: string | null; requestSummary: string; requestMessageId: string | null; createdAt: string }>;
          approvals?: Array<Omit<PendingRunStartApproval, "sensitiveAreas"> & { sensitiveAreas?: string[] }>;
          findings?: PendingFinding[];
          drafts?: PendingRuleDraft[];
          permissions?: PendingBridgePermission[];
          submissions?: PendingEvidenceSubmission[];
          taskContracts?: TaskCardContract[];
        };
        if (cancelled) return;
        setPendingTaskContracts(data.taskContracts ?? []);
        setNotifications(data.notifications ?? []);
        setUnreadNotificationCount(typeof data.unreadNotificationCount === "number" ? data.unreadNotificationCount : 0);
        setPendingEvidenceRequests((data.requests ?? [])
          .filter((row) => !decidedEvidenceRequestIds.has(row.id))
          .map((row) => ({ id: row.id, conversationId: row.conversationId, agentConnectionId: row.agentConnectionId, provider: row.provider, requestSummary: row.requestSummary, requestMessageId: row.requestMessageId, createdAt: row.createdAt })));
        setPendingRunStartApprovals((data.approvals ?? [])
          .filter((approval) => !decidedRunStartApprovalIds.has(approval.id))
          .map((approval) => ({ ...approval, sensitiveAreas: approval.sensitiveAreas ?? [] })));
        setPendingFindings((data.findings ?? []).filter((finding) => !decidedFindingIds.has(finding.id)));
        setPendingRuleDrafts((data.drafts ?? []).filter((draft) => !decidedRuleDraftIds.has(draft.id)));
        setPendingPermissions((data.permissions ?? []).filter((permission) => permission.messageId && !decidedPermissionIds.has(permission.id)));
        setPendingEvidenceSubmissions((data.submissions ?? []).filter((submission) => submission.messageId && !decidedEvidenceSubmissionIds.has(submission.id)));
      } catch { /* every one of these cards is additive; chat stays fully usable without them */ }
    }
    void loadPendingDecisions();
    const id = window.setInterval(() => void loadPendingDecisions(), 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [decidedEvidenceRequestIds, decidedRunStartApprovalIds, decidedFindingIds, decidedRuleDraftIds, decidedPermissionIds, decidedEvidenceSubmissionIds]);

  async function decideRunStartApproval(approvalId: string, approved: boolean) {
    if (runStartDecisionBusyId) return;
    setRunStartDecisionBusyId(approvalId);
    // Decided-id set, not a whole-list snapshot: a poll response already in
    // flight when this click happens (or one that lands before the server
    // commits) filters this id out too instead of overwriting the optimistic
    // removal wholesale. Rolling back on failure removes only this id, so it
    // never resurrects other cards a legitimate intervening poll had dropped.
    setDecidedRunStartApprovalIds((current) => new Set(current).add(approvalId));
    const decided = pendingRunStartApprovals.find((approval) => approval.id === approvalId);
    if (decided?.requestMessageId) {
      setResolvedCards((current) => ({ ...current, [decided.requestMessageId!]: { label: approved ? "Approved" : "Rejected", outcome: approved ? "approved" : "neutral", decidedAt: Date.now() } }));
    }
    setPendingRunStartApprovals((current) => current.filter((approval) => approval.id !== approvalId));
    try {
      const res = await fetch("/api/dashboard/run-start-approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: approvalId, approved }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDecidedRunStartApprovalIds((current) => { const next = new Set(current); next.delete(approvalId); return next; });
        setNotice(body.error ?? "Could not record that decision.");
      }
    } catch {
      setDecidedRunStartApprovalIds((current) => { const next = new Set(current); next.delete(approvalId); return next; });
      setNotice("Could not record that decision.");
    } finally {
      setRunStartDecisionBusyId(null);
    }
  }

  /** action: "promote" drafts a rule from the finding's evidence; "available"/"retired" are plain review decisions. All three end the pending state, so all three retire the card. */
  async function decideFinding(findingId: string, action: "promote" | "available" | "retired") {
    if (findingDecisionBusyId || !workspaceId) return;
    setFindingDecisionBusyId(findingId);
    setDecidedFindingIds((current) => new Set(current).add(findingId));
    const decided = pendingFindings.find((finding) => finding.id === findingId);
    if (decided?.announcementMessageId) {
      const label = action === "promote" ? "Approved & rule suggested" : action === "available" ? "Marked available" : "Retired";
      setResolvedCards((current) => ({ ...current, [decided.announcementMessageId!]: { label, outcome: action === "promote" ? "approved" : "neutral", decidedAt: Date.now() } }));
    }
    setPendingFindings((current) => current.filter((finding) => finding.id !== findingId));
    try {
      const url = action === "promote" ? `/api/agent/findings/${findingId}/promote-to-rule` : `/api/agent/findings/${findingId}/review`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "promote" ? { workspace_id: workspaceId } : { decision: action, workspace_id: workspaceId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDecidedFindingIds((current) => { const next = new Set(current); next.delete(findingId); return next; });
        setNotice(body.error ?? "Could not record that decision.");
      }
    } catch {
      setDecidedFindingIds((current) => { const next = new Set(current); next.delete(findingId); return next; });
      setNotice("Could not record that decision.");
    } finally {
      setFindingDecisionBusyId(null);
    }
  }

  async function decideRuleDraft(ruleId: string, approved: boolean) {
    if (ruleDraftDecisionBusyId) return;
    setRuleDraftDecisionBusyId(ruleId);
    setDecidedRuleDraftIds((current) => new Set(current).add(ruleId));
    const decidedDraft = pendingRuleDrafts.find((draft) => draft.id === ruleId);
    if (decidedDraft?.announcementMessageId) {
      setResolvedCards((current) => ({ ...current, [decidedDraft.announcementMessageId!]: { label: approved ? "Promoted to active" : "Discarded", outcome: approved ? "approved" : "neutral", decidedAt: Date.now() } }));
    }
    setPendingRuleDrafts((current) => current.filter((draft) => draft.id !== ruleId));
    try {
      const res = approved
        ? await fetch("/api/agent/rules/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule_id: ruleId }) })
        : await fetch(`/api/workspace-rules/${ruleId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDecidedRuleDraftIds((current) => { const next = new Set(current); next.delete(ruleId); return next; });
        setNotice(body.error ?? "Could not record that decision.");
      }
    } catch {
      setDecidedRuleDraftIds((current) => { const next = new Set(current); next.delete(ruleId); return next; });
      setNotice("Could not record that decision.");
    } finally {
      setRuleDraftDecisionBusyId(null);
    }
  }

  async function decidePermission(id: string, approved: boolean) {
    if (permissionDecisionBusyId) return;
    setPermissionDecisionBusyId(id);
    setDecidedPermissionIds((current) => new Set(current).add(id));
    const decidedPermission = pendingPermissions.find((permission) => permission.id === id);
    if (decidedPermission?.messageId) {
      setResolvedCards((current) => ({ ...current, [decidedPermission.messageId!]: { label: approved ? "Approved" : "Denied", outcome: approved ? "approved" : "neutral", decidedAt: Date.now() } }));
    }
    setPendingPermissions((current) => current.filter((permission) => permission.id !== id));
    try {
      const res = await fetch("/api/dashboard/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, approved }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDecidedPermissionIds((current) => { const next = new Set(current); next.delete(id); return next; });
        setNotice(body.error ?? "Could not record that decision.");
      }
    } catch {
      setDecidedPermissionIds((current) => { const next = new Set(current); next.delete(id); return next; });
      setNotice("Could not record that decision.");
    } finally {
      setPermissionDecisionBusyId(null);
    }
  }

  async function decideEvidenceSubmission(id: string, approved: boolean) {
    if (evidenceSubmissionDecisionBusyId) return;
    setEvidenceSubmissionDecisionBusyId(id);
    setDecidedEvidenceSubmissionIds((current) => new Set(current).add(id));
    const decidedSubmission = pendingEvidenceSubmissions.find((submission) => submission.id === id);
    if (decidedSubmission?.messageId) {
      setResolvedCards((current) => ({ ...current, [decidedSubmission.messageId!]: { label: approved ? "Approved" : "Rejected", outcome: approved ? "approved" : "neutral", decidedAt: Date.now() } }));
    }
    setPendingEvidenceSubmissions((current) => current.filter((submission) => submission.id !== id));
    try {
      const res = await fetch("/api/dashboard/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, approved }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDecidedEvidenceSubmissionIds((current) => { const next = new Set(current); next.delete(id); return next; });
        setNotice(body.error ?? "Could not record that decision.");
      }
    } catch {
      setDecidedEvidenceSubmissionIds((current) => { const next = new Set(current); next.delete(id); return next; });
      setNotice("Could not record that decision.");
    } finally {
      setEvidenceSubmissionDecisionBusyId(null);
    }
  }

  async function decideEvidenceRequest(requestId: string, approved: boolean) {
    if (evidenceDecisionBusyId) return;
    setEvidenceDecisionBusyId(requestId);
    setDecidedEvidenceRequestIds((current) => new Set(current).add(requestId));
    const decidedRequest = pendingEvidenceRequests.find((request) => request.id === requestId);
    if (decidedRequest?.requestMessageId) {
      setResolvedCards((current) => ({ ...current, [decidedRequest.requestMessageId!]: { label: approved ? "Approved" : "Rejected", outcome: approved ? "approved" : "neutral", decidedAt: Date.now() } }));
    }
    setPendingEvidenceRequests((current) => current.filter((request) => request.id !== requestId));
    try {
      const res = await fetch("/api/dashboard/evidence-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: requestId, approved }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDecidedEvidenceRequestIds((current) => { const next = new Set(current); next.delete(requestId); return next; });
        setNotice(body.error ?? "Could not record that decision.");
      }
    } catch {
      setDecidedEvidenceRequestIds((current) => { const next = new Set(current); next.delete(requestId); return next; });
      setNotice("Could not record that decision.");
    } finally {
      setEvidenceDecisionBusyId(null);
    }
  }

  // Build the lookup from the current snapshot. The relay cursor and
  // conversation state already prevent stale agent rows from being rendered;
  // mutating a ref during render made the lookup non-deterministic and caused
  // the React compiler lint failure that surfaced during the full audit.
  const byConnectionId = useMemo(() => {
    const next = new Map<string, AgentView>();
    for (const agent of agents) {
      if (agent.connectionId) next.set(agent.connectionId, agent);
    }
    return next;
  }, [agents]);
  /** Resolves each raw session into what a pane actually needs to render -- owner badge/label and whether the current viewer is that owner. */
  const ptyRoomSessions = useMemo<PtyRoomSession[]>(() => {
    return Object.values(ptySessions).map((session) => {
      // ownerParticipantId is the *agent connection's* id (the bridge that
      // actually hosts the pty), never a human's -- comparing it directly
      // against a human viewer's participantId could never match, which
      // would make the owner-only Sharing toggle permanently unusable for
      // every real user. The real question is "does this connection's
      // owning human match the current viewer," answered through
      // agent_connections.created_by (AgentView.owner_user_id).
      const ownerConnection = byConnectionId.get(session.ownerParticipantId);
      const isOwner = Boolean(ownerConnection?.ownerUserId) && ownerConnection!.ownerUserId === viewerParticipantId;
      return { ...session, linkedSessionIds: session.linkedSessionIds ?? [], isOwner, ownerLabel: isOwner ? undefined : ownerConnection?.label ?? "Agent", agentKey: ownerConnection?.key };
    });
  }, [ptySessions, byConnectionId, viewerParticipantId]);
  /** Recognized @mention names for the composer's inline highlight (below) --
   * the same identity every mention/routing check in this file already uses. */
  const agentMentionKeys = useMemo(() => new Set(agents.map((agent) => agent.key.toLowerCase())), [agents]);
  /** Real agent objects for every @handle currently typed in the draft, in
   * first-appearance order, deduped -- backs the composer's mention chip row.
   * A plain colored span in the draft text told you nothing about WHICH
   * agent that was beyond its raw handle; this resolves it to the same
   * AgentMark + display label used everywhere else in the app. */
  const mentionedAgentsInDraft = useMemo(() => {
    const seen = new Set<string>();
    const out: AgentView[] = [];
    for (const match of draft.matchAll(/@([a-z][a-z0-9-]*)/gi)) {
      const key = match[1].toLowerCase();
      if (!agentMentionKeys.has(key) || seen.has(key)) continue;
      const agent = agents.find((candidate) => candidate.key.toLowerCase() === key);
      if (!agent) continue;
      seen.add(key);
      out.push(agent);
    }
    return out;
  }, [draft, agentMentionKeys, agents]);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  // Nothing selected yet (a bare /dashboard/agents, or a ?conversation= that
  // no longer exists): land on the single unified #general room -- the
  // workspace's one shared feed, per the one-channel redesign (agents are
  // addressed with @mention inside it, not via a channel switcher). Falls
  // back to the most recently active real channel only if #general is
  // somehow missing (e.g. before ensureWorkspaceChannelsForDashboard has
  // provisioned it yet).
  useEffect(() => {
    if (conversations.length === 0 || selected) return;
    const fallback = conversations.find((conversation) => conversation.id === deepLinkConversationId)
      ?? conversations.find((conversation) => conversation.channel_slug === "general")
      ?? [...conversations]
        .filter((conversation) => channelGroupForConversation(conversation) !== "diagnostic")
        .sort((left, right) => lastActivityMs(right) - lastActivityMs(left))[0]
      ?? [...conversations].sort((left, right) => lastActivityMs(right) - lastActivityMs(left))[0];
    if (fallback) selectConversation(fallback.id);
    // selectConversation is a stable router.replace wrapper; re-running this on
    // its identity would fight the navigation it just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, selected]);

  // Every way a live turn indicator is allowed to end, each tied to a real
  // observation rather than a clock:
  //   1. that agent's own reply lands in this conversation (durable, and the
  //      one signal that survives a dropped `workspace.turn` "ended");
  //   2. the optimistic entry the composer created was never confirmed by
  //      the backend within a short grace -- the absence of a real signal is
  //      the answer, and it is removed rather than left running;
  //   3. a settled (failed/cancelled) entry has shown its outcome long
  //      enough to be read.
  // Notably absent: the old blanket 5-minute timeout on a *confirmed* turn.
  // A real turn legitimately runs longer than that, and this must never
  // claim a turn ended just because it has been a while.
  // Derived, not stored: an entry stops being shown the moment one of those
  // observations holds, so no effect has to race a timer to "clean up" state
  // the render can already decide about. `turnDeadlineTick` exists only to
  // re-run this at the moment a deadline passes when nothing else would.
  const visibleTurns = useMemo(() => {
    const nowMs = turnClockMs;
    // The relay is the only path these signals travel. Once it is no longer
    // subscribed, this client genuinely cannot know whether a turn is still
    // running -- so it stops claiming to, rather than freezing the last
    // state on screen indefinitely.
    if (relayStatus !== "subscribed") return [];
    return Object.values(agentTurns)
      .filter((turn) => {
        if (turn.ended) return nowMs - turn.ended.atMs < ENDED_TURN_LINGER_MS;
        if (!turn.confirmed && nowMs - turn.startedAtMs >= OPTIMISTIC_TURN_GRACE_MS) return false;
        return !selected?.messages.some((message) => message.sender_connection_id === turn.connectionId && Date.parse(message.created_at) >= turn.startedAtMs);
      })
      // Oldest first: a second agent joining an in-flight turn appears under
      // the one already running rather than displacing it.
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }, [agentTurns, relayStatus, selected, turnClockMs]);
  // Was gated on turn.confirmed (a real `workspace.turn started` relay
  // frame) -- honest in principle, but that frame is best-effort and not
  // always delivered promptly, which meant Stop could stay hidden for a
  // turn that was genuinely running the whole time. A provider's own chat
  // UI shows Stop the instant you hit send, before it has any server
  // confirmation either -- match that: the optimistic turn (created on send,
  // see the mention-dispatch effect below) is enough to offer Stop. The
  // cancel request itself is safe to fire early regardless: it's a durable,
  // TTL'd row the Bridge polls for and consumes the moment a real session
  // exists, not something that requires a session to already be running.
  const runningTurns = visibleTurns.filter((turn) => !turn.ended);
  const soleRunningTurn = runningTurns.length === 1 ? runningTurns[0] : null;
  useEffect(() => {
    // Only the two time-based rules need waking up; a confirmed, running turn
    // has no deadline at all. The old blanket 5-minute timeout is gone
    // deliberately -- a real turn legitimately runs longer than that, and
    // this must never claim a turn ended just because it has been a while.
    const deadlines = visibleTurns.flatMap((turn) => turn.ended
      ? [turn.ended.atMs + ENDED_TURN_LINGER_MS]
      : turn.confirmed ? [] : [turn.startedAtMs + OPTIMISTIC_TURN_GRACE_MS]);
    if (deadlines.length === 0) return;
    const timeout = window.setTimeout(() => setTurnClockMs(Date.now()), Math.max(250, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [visibleTurns]);

  // Land on the latest message: opening a channel or its most recent message
  // updating should always scroll the reader to what just happened, not
  // leave them wherever the list last rendered.
  const latestMessageId = selected?.messages[selected.messages.length - 1]?.id ?? null;
  const selectedMessageCount = selected?.messages.length ?? 0;
  const scrollMemoRef = useRef<{ id: string | null; latest: string | null; count: number }>({ id: null, latest: null, count: 0 });
  useEffect(() => {
    const list = messagesListRef.current;
    if (!list) return;
    const id = selected?.id ?? null;
    const memo = scrollMemoRef.current;
    // Also re-anchor when full history replaces the 1-message preview a
    // freshly opened channel starts with -- otherwise the list stays at the top.
    const historyArrived = memo.id === id && memo.count <= 1 && selectedMessageCount > memo.count;
    if (memo.id !== id || memo.latest !== latestMessageId || historyArrived) {
      list.scrollTop = list.scrollHeight;
    }
    scrollMemoRef.current = { id, latest: latestMessageId, count: selectedMessageCount };
  }, [selected?.id, latestMessageId, selectedMessageCount]);

  // Runs after the "scroll to latest" effect above has already fired for
  // this conversation -- a deep link (from the old standalone approval
  // page, or a Live Sessions "Join" link) overrides landing on the newest
  // message and instead scrolls to and briefly highlights the specific
  // message its card is attached to. Re-arms on every distinct
  // conversation+message pair (not just once at mount), so clicking a new
  // Join link while already inside the app works, not just a hard page load.
  useEffect(() => {
    if (!deepLinkConversationId || !deepLinkMessageId) return;
    if (selected?.id !== deepLinkConversationId) return;
    const key = `${deepLinkConversationId}:${deepLinkMessageId}`;
    if (consumedDeepLinkKeyRef.current === key) return;
    if (!selected.messages.some((message) => message.id === deepLinkMessageId)) return;
    const target = document.getElementById(`message-${deepLinkMessageId}`);
    if (!target) return;
    consumedDeepLinkKeyRef.current = key;
    target.scrollIntoView({ block: "center" });
    target.classList.add("wf-chat-message-deeplinked");
    window.setTimeout(() => target.classList.remove("wf-chat-message-deeplinked"), 2400);
  }, [selected, deepLinkConversationId, deepLinkMessageId]);

  // Lookup for the quoted reply-preview below: a reply carries only its
  // parent's id on the wire, and the parent is always already loaded in this
  // same channel's message list (it is what the reply is answering).
  const messagesById = useMemo(() => {
    const next = new Map<string, ConversationMessage>();
    for (const message of selected?.messages ?? []) next.set(message.id, message);
    return next;
  }, [selected?.messages]);

  /** Jump to and briefly highlight a message already in the loaded feed --
   * the same highlight the deep-link effect above uses, reused here for a
   * reply's quoted-preview click so "what did this reply to" is one click,
   * not a scroll-and-hunt. */
  function scrollToMessage(messageId: string) {
    const target = document.getElementById(`message-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("wf-chat-message-deeplinked");
    window.setTimeout(() => target.classList.remove("wf-chat-message-deeplinked"), 2400);
  }

  const taskContractByAnchorMessageId = useMemo(() => {
    const next = new Map<string, TaskCardContract>();
    for (const contract of pendingTaskContracts) next.set(contract.anchorMessageId, contract);
    return next;
  }, [pendingTaskContracts]);
  const evidenceRequestByMessageId = useMemo(() => {
    const next = new Map<string, PendingEvidenceRequest>();
    for (const request of pendingEvidenceRequests) {
      if (request.requestMessageId) next.set(request.requestMessageId, request);
    }
    return next;
  }, [pendingEvidenceRequests]);
  const runStartApprovalByMessageId = useMemo(() => {
    const next = new Map<string, PendingRunStartApproval>();
    for (const approval of pendingRunStartApprovals) {
      if (approval.requestMessageId) next.set(approval.requestMessageId, approval);
    }
    return next;
  }, [pendingRunStartApprovals]);
  const findingByMessageId = useMemo(() => {
    const next = new Map<string, PendingFinding>();
    for (const finding of pendingFindings) {
      if (finding.announcementMessageId) next.set(finding.announcementMessageId, finding);
    }
    return next;
  }, [pendingFindings]);
  const ruleDraftByMessageId = useMemo(() => {
    const next = new Map<string, PendingRuleDraft>();
    for (const draft of pendingRuleDrafts) {
      if (draft.announcementMessageId) next.set(draft.announcementMessageId, draft);
    }
    return next;
  }, [pendingRuleDrafts]);
  const permissionByMessageId = useMemo(() => {
    const next = new Map<string, PendingBridgePermission>();
    for (const permission of pendingPermissions) {
      if (permission.messageId) next.set(permission.messageId, permission);
    }
    return next;
  }, [pendingPermissions]);
  const evidenceSubmissionByMessageId = useMemo(() => {
    const next = new Map<string, PendingEvidenceSubmission>();
    for (const submission of pendingEvidenceSubmissions) {
      if (submission.messageId) next.set(submission.messageId, submission);
    }
    return next;
  }, [pendingEvidenceSubmissions]);
  // A-6: grouped by turn, newest turn first -- the placement research
  // converged on this exact shape (Claude Code Desktop's tasks pane,
  // Perplexity Computer's activity panel, Codex's task sidebar): a separate
  // live surface with one entry per turn, not an accordion woven into each
  // chat message.
  const stepGroups = useMemo(() => {
    const byMessage = new Map<string, WorkspaceStep[]>();
    for (const step of workspaceSteps) {
      const list = byMessage.get(step.messageId) ?? [];
      list.push(step);
      byMessage.set(step.messageId, list);
    }
    return [...byMessage.entries()]
      .map(([messageId, steps]) => ({
        messageId,
        steps: steps.slice(-40),
        latestAtMs: Math.max(...steps.map((s) => s.receivedAtMs)),
        // Not per-step status: a real file.read activity event only ever
        // carries "started" (confirmed live -- a completed read has no
        // paired "succeeded" event to flip on), so that alone can never
        // settle. The turn's real, durable completion signal is its own
        // reply already landing in the conversation -- bridge-runtime.ts's
        // postWorkspaceResult/postWorkspaceStep both anchor to this exact
        // messageId as the parent, so an agent reply parented to it means
        // the turn is genuinely done, not just idle between steps.
        inProgress: !selected?.messages.some((message) => message.parent_message_id === messageId && Boolean(message.sender_connection_id)),
      }))
      .filter((group) => selected?.messages.some((message) => message.id === group.messageId))
      .sort((a, b) => b.latestAtMs - a.latestAtMs)
      .slice(0, 8);
  }, [workspaceSteps, selected]);
  /** Lookup for rendering a step group inline, next to the message that
   * actually triggered it -- see the note above where this is consumed for
   * why the group was previously pinned above the whole scrolled feed
   * instead, which made it invisible the moment a channel had more than one
   * screen of history. */
  const stepGroupByMessageId = useMemo(() => new Map(stepGroups.map((group) => [group.messageId, group])), [stepGroups]);
  const threadRoot = selected && replyTargetId ? selected.messages.find((message) => message.id === replyTargetId) ?? null : null;
  const threadReplies = selected && threadRoot ? selected.messages.filter((message) => message.parent_message_id === threadRoot.id) : [];
  /* Slack-style "N replies" indicator: the wf-chat-thread panel already
     exists (opened via replyTargetId) but had no visible entry point on a
     root message -- a human scanning the feed had no way to know a thread
     existed without hovering the reply icon or scrolling past its inline
     replies. This is purely a count + "who replied" summary; it never hides
     the replies themselves, which still render inline too (deliberate --
     see the note above the thread aside). */
  const replyCountByRootId = useMemo(() => {
    const counts = new Map<string, { count: number; lastRepliedAt: string }>();
    if (!selected) return counts;
    for (const message of selected.messages) {
      if (!message.parent_message_id) continue;
      const entry = counts.get(message.parent_message_id) ?? { count: 0, lastRepliedAt: message.created_at };
      entry.count += 1;
      entry.lastRepliedAt = message.created_at;
      counts.set(message.parent_message_id, entry);
    }
    return counts;
  }, [selected]);
  const mentionToken = draft.match(/(?:^|\s)@([a-z0-9 -]*)$/i)?.[1] ?? null;
  // Matched against agent.key (the stable provider kind: "claude-code",
  // "codex", ...), never agent.label -- per-owner identity (item #2) made
  // label an owner-qualified display string ("Maya's Claude Code"), which
  // breaks two things if it leaks into @mention text: the token inserted
  // would contain the owner's name and possibly an apostrophe, and typing
  // "@co" to find Codex would stop matching once the label starts with an
  // owner's name instead of the provider name. agent.key never changes, so
  // @mentions stay exactly as reliable as before this feature existed.
  const mentionNeedle = mentionToken === null ? null : mentionToken.toLowerCase().replace(/\s+/g, "-");
  // Offline agents stay in the list (marked offline) so a typed @name never just
  // vanishes; reachable ones sort first. Matches the provider key or any word of the label.
  const mentionSuggestions = mentionNeedle === null ? [] : agents
    .filter((agent) => agent.key.toLowerCase().startsWith(mentionNeedle)
      || agent.label.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.length > 0 && word.startsWith(mentionNeedle)))
    .sort((left, right) => Number(right.connected) - Number(left.connected))
    .slice(0, 6);
  // The menu renders in a portal on <body>, positioned from the composer's
  // rect: inside the composer it could be clipped or covered by whatever
  // sits above it in the chat stack.
  const composerFieldRef = useRef<HTMLDivElement | null>(null);
  const [mentionMenuRect, setMentionMenuRect] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const hasMentionMenu = mentionSuggestions.length > 0;
  useEffect(() => {
    if (!hasMentionMenu) { setMentionMenuRect(null); return; }
    const measure = () => {
      const field = composerFieldRef.current;
      if (!field) return;
      const rect = field.getBoundingClientRect();
      setMentionMenuRect({ left: rect.left, bottom: window.innerHeight - rect.top + 6, width: rect.width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [hasMentionMenu, draft]);
  const activeMentionIndex = mentionSuggestions.length > 0 ? mentionActiveIndex % mentionSuggestions.length : 0;

  /** Typing "/" at the start of an empty draft opens the same shortcut menu the toolbar icon does, filtered as you type -- mirrors mentionToken's pattern above. */
  const slashToken = draft.match(/^\/([a-z]*)$/i)?.[1] ?? null;
  const slashSuggestions = slashToken === null ? MESSAGE_SHORTCUTS : MESSAGE_SHORTCUTS.filter((shortcut) => shortcut.prefix.slice(1).startsWith(slashToken.toLowerCase()));

  // Same @mention match submit() uses to decide who an outgoing message is
  // for -- reused here so the /route nudge names the agent that's actually
  // about to receive the message, not just whichever one is selected.
  const mentionedAgent = useMemo(() => agents.find((agent) => agent.connected && agent.connectionId
    // agent.key, not agent.label -- see the mentionSuggestions note above.
    && new RegExp(`(^|\\s)@${agent.key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9-])`, "i").test(draft)) ?? null,
  [agents, draft]);
  const mentionedAgentTier = mentionedAgent ? getModelTier(mentionedAgent.model) : null;
  useEffect(() => {
    // A new mention target gets a fresh dismiss affordance.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRouteSuggestionDismissed(false);
  }, [mentionedAgent?.connectionId]);
  const routeSuggestion = !routeSuggestionDismissed && mentionedAgent && mentionedAgentTier === 1 && draftLooksComplex(draft)
    ? { agent: mentionedAgent, tier: mentionedAgentTier }
    : null;
  const shortcutMenuOpen = showShortcuts || slashToken !== null;

  // "You" is never correct here: labelFor only resolves *other* participants
  // (viewer's own messages/typing are excluded before this is called). A
  // missing connectionId means the sender has no known identity at all.
  function labelFor(connectionId: string | null): string {
    const agent = connectionId ? byConnectionId.get(connectionId) : undefined;
    if (!agent) return "Someone";
    // AgentView.label already has the "Owner's Provider" format when disambiguated,
    // or just "Provider" when unique. This matches getAgentDisplayName's output.
    return agent.label;
  }

  function selectMention(agent: AgentView) {
    // Inserts agent.key (e.g. "@codex"), not agent.label -- see the
    // mentionSuggestions note above for why the display label can't be the
    // inserted token once it's owner-qualified.
    setDraft((current) => current.replace(/(^|\s)@[a-z0-9 -]*$/i, `$1@${agent.key.toLowerCase()} `));
    setMentionActiveIndex(0);
  }

  function applyShortcut(prefix: string) {
    setDraft((current) => (slashToken !== null ? `${prefix} ` : current.trim() ? `${prefix} ${current}` : `${prefix} `));
    setShowShortcuts(false);
    textareaRef.current?.focus();
  }

  function insertMentionTrigger() {
    setDraft((current) => (current.endsWith(" ") || current.length === 0 ? `${current}@` : `${current} @`));
    textareaRef.current?.focus();
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (mentionSuggestions.length === 0) {
      if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (draft.trim()) event.currentTarget.form?.requestSubmit();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionActiveIndex((current) => (current + 1) % mentionSuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionActiveIndex((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectMention(mentionSuggestions[activeMentionIndex] ?? mentionSuggestions[0]);
    } else if (event.key === "Escape") {
      setDraft((current) => current.replace(/(^|\s)@[a-z0-9 -]*$/i, "$1"));
    }
  }

  /**
   * A-1 (perceived speed, decided 2026-08-23): the local echo of the human's
   * own message must never wait on the network -- submit() below appends it
   * to state and clears the composer synchronously. This function is only
   * the network half, called fire-and-forget so typing/sending the next
   * message is never blocked on this one's round trip. It reconciles the
   * optimistic row (found by clientRequestId, since the server assigns the
   * real id) to either the server's confirmed message or a visible "failed"
   * state -- pending must resolve to one of those two, never disappear and
   * never silently claim success it hasn't earned.
   */
  async function deliverMessage(conversationId: string, body: string, parentMessageId: string | null, clientRequestId: string) {
    try {
      let posted: ConversationMessage | null = null;
      if (relayRef.current?.isOpen) {
        try {
          const live = await relayRef.current.postMessage({ body, parentMessageId, clientRequestId });
          posted = live.message && typeof live.message === "object" ? normalizeIncomingMessage(live.message as ConversationMessage) : null;
        } catch { /* HTTP persistence is the truthful fallback when the live relay is restarting. */ }
      }
      if (!posted) {
        const response = await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": clientRequestId },
          body: JSON.stringify({ body, parentMessageId, idempotencyKey: clientRequestId }),
        });
        const responseBody = await response.json().catch(() => ({})) as { message?: ConversationMessage; error?: string };
        if (!response.ok || !responseBody.message) throw new Error(responseBody.error ?? "Could not send message.");
        posted = responseBody.message;
      }
      const confirmed = posted;
      setConversations((current) => current.map((conversation) => conversation.id !== conversationId ? conversation : {
        ...conversation,
        // Replace the pending row in place (same position) rather than
        // appending -- appending would jump a message that's already
        // visible to the bottom the instant it confirms.
        messages: conversation.messages.some((item) => item.id === confirmed.id)
          ? conversation.messages.filter((item) => item.clientRequestId !== clientRequestId || item.id === confirmed.id)
          : conversation.messages.map((item) => item.clientRequestId === clientRequestId ? confirmed : item),
        unread_count: 0,
      }));
    } catch (error) {
      setConversations((current) => current.map((conversation) => conversation.id !== conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map((item) => item.clientRequestId === clientRequestId ? { ...item, sendStatus: "failed" as const } : item),
      }));
      setNotice(error instanceof Error ? error.message : "Could not send message.");
    }
  }

  function retrySend(message: ConversationMessage) {
    if (!selected || !message.clientRequestId) return;
    setConversations((current) => current.map((conversation) => conversation.id !== selected.id ? conversation : {
      ...conversation,
      messages: conversation.messages.map((item) => item.id === message.id ? { ...item, sendStatus: "pending" as const } : item),
    }));
    void deliverMessage(selected.id, message.body, message.parent_message_id, message.clientRequestId);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft.trim()) return;
    setNotice(null);
    const body = draft;
    const conversationId = selected.id;
    const parentMessageId = replyTargetId;
    // One client request id follows this post through relay reconnects and
    // the HTTP fallback. The database unique index makes an ambiguous
    // acknowledgement replay-safe instead of creating a duplicate message.
    const clientRequestId = `dashboard-post:${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const optimistic: ConversationMessage = {
      id: `pending:${clientRequestId}`,
      sender_connection_id: null,
      sender_user_id: viewerUserId,
      sender_display_name: "Me",
      recipient_connection_id: null,
      kind: "message",
      body,
      created_at: new Date().toISOString(),
      spawned_run_id: null,
      parent_message_id: parentMessageId,
      edited_at: null,
      deleted_at: null,
      reactions: [],
      attachments: [],
      todos: [],
      sendStatus: "pending",
      clientRequestId,
    };
    // Echo and clear the composer synchronously -- this is the part that
    // must never wait on a round trip. The network call below is
    // fire-and-forget from this function's point of view.
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: [...conversation.messages, optimistic], unread_count: 0 }
      : conversation));
    setDraft("");
    setReplyTargetId(null);
    setShowShortcuts(false);
    setInterjectFor(null);
    setRouteSuggestionDismissed(false);
    void relayRef.current?.setTyping(false);
    // Optimism only, and it says so: whichever connected agent this message
    // names gets an *unconfirmed* entry so the composer responds instantly,
    // reading "Waiting to start…" rather than asserting work is underway.
    // The backend's own `workspace.turn` frame is what promotes it to a real
    // running state; nothing arriving within OPTIMISTIC_TURN_GRACE_MS
    // removes it again. Same slug match already used for @mention
    // autocomplete, so "mentioned" means the same thing here as everywhere
    // else in this composer.
    // agent.key, not agent.label -- see the mentionSuggestions note above.
    const mentioned = agents.find((agent) => agent.connected && agent.connectionId
      && new RegExp(`(^|\\s)@${agent.key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9-])`, "i").test(body));
    if (mentioned?.connectionId) {
      const connectionId = mentioned.connectionId;
      setAgentTurns((current) => current[connectionId] && !current[connectionId].ended
        ? current
        : { ...current, [connectionId]: { connectionId, startedAtMs: Date.now(), confirmed: false, messageId: null, action: null, ended: null } });
    }
    void deliverMessage(conversationId, body, parentMessageId, clientRequestId);
  }

  async function attachFile(file: File) {
    if (!selected || uploadingAttachment) return;
    setUploadingAttachment(true);
    setNotice(null);
    try {
      const clientRequestId = `dashboard-post:${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      const body = draft.trim() || file.name;
      const response = await fetch(`/api/dashboard/conversations/${encodeURIComponent(selected.id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": clientRequestId },
        body: JSON.stringify({ body, parentMessageId: replyTargetId, idempotencyKey: clientRequestId }),
      });
      const posted = await response.json().catch(() => ({})) as { message?: ConversationMessage; error?: string };
      if (!response.ok || !posted.message) throw new Error(posted.error ?? "Could not send message.");
      const form = new FormData();
      form.set("file", file);
      form.set("messageId", posted.message.id);
      const uploadResponse = await fetch(`/api/dashboard/conversations/${encodeURIComponent(selected.id)}/attachments`, { method: "POST", body: form });
      const uploadBody = await uploadResponse.json().catch(() => ({})) as { attachment?: ConversationMessage["attachments"][number]; error?: string };
      if (!uploadResponse.ok || !uploadBody.attachment) throw new Error(uploadBody.error ?? "Could not upload the attachment.");
      const messageWithAttachment: ConversationMessage = { ...posted.message, reactions: posted.message.reactions ?? [], attachments: [uploadBody.attachment] };
      setConversations((current) => current.map((conversation) => conversation.id === selected.id
        ? { ...conversation, messages: mergeConversationMessages(conversation.messages, [messageWithAttachment]), unread_count: 0 }
        : conversation));
      setDraft("");
      setReplyTargetId(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not attach the file.");
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function markRead(conversation: Conversation) {
    const last = conversation.messages.at(-1);
    if (!last || conversation.unread_count === 0) return;
    setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, unread_count: 0 } : item));
    await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversation.id)}/read`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: last.id }) }).catch(() => undefined);
  }

  // Opening a channel used to mark it read (and anchor the unread divider)
  // from the sidebar row's own onClick. That row is now a nav link in the
  // shell, so the feed does it when the open channel changes instead.
  const openedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || openedConversationRef.current === selected.id) return;
    openedConversationRef.current = selected.id;
    const opened = selected;
    queueMicrotask(() => {
      if (opened.unread_count > 0) {
        const firstUnread = opened.messages[Math.max(0, opened.messages.length - opened.unread_count)];
        if (firstUnread) setUnreadBoundary({ conversationId: opened.id, messageId: firstUnread.id });
      }
      void markRead(opened);
    });
    // markRead is a fetch helper redefined every render; the ref guard above is
    // what keeps this to one call per channel opened, not the dep list.
  }, [selected]);

  // The Stop button. Leaves a durable request row the owning Bridge process
  // consumes on its next poll (see scanPendingCancelTurns in
  // bridge-runtime.ts) and actually delivers via the real ACP cancel() RPC.
  // A cancelled turn never produces a normal reply, so the "clear on reply"
  // rule alone would leave Stop showing with zero feedback -- confirmed
  // live, this is exactly what "the button stays the same, no way to know if
  // it stopped" looked like. Two independent confirmations now close that:
  // this poll of the same status the Bridge just wrote ("consumed" means
  // genuinely delivered, not guessed), and the Bridge's own
  // `workspace.turn` "ended" with outcome "cancelled", which is the ACP
  // stopReason the cancelled provider turn really returned. Keyed by
  // connectionId throughout so stopping one agent never touches another's
  // indicator when two are working at once.
  async function requestStopTurn(conversationId: string, connectionId: string) {
    setCancelingConnectionIds((current) => current.includes(connectionId) ? current : [...current, connectionId]);
    const finish = () => setCancelingConnectionIds((current) => current.filter((id) => id !== connectionId));
    try {
      const response = await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/cancel-turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      }).catch(() => null);
      if (!response?.ok) { setNotice("Could not send the stop request."); finish(); return; }
    } catch {
      setNotice("Could not send the stop request.");
      finish();
      return;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1_500));
      const statusResponse = await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/cancel-turn?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store" }).catch(() => null);
      const body = statusResponse?.ok ? await statusResponse.json().catch(() => null) as { status?: string } | null : null;
      if (body?.status === "consumed") {
        // Delivered. The turn's own "ended/cancelled" frame is what settles
        // the indicator (and shows "Stopped"); this only stops the button
        // spinning. If that frame never arrives -- a relay drop mid-cancel --
        // the entry still clears through the rules in the effect above.
        setInterjectFor({ connectionId, label: labelFor(connectionId) });
        setDraft((current) => current.trim() ? current : `@${labelFor(connectionId).toLowerCase().replace(/\s+/g, "-")} `);
        break;
      }
      // Live-caught: a click filed while nothing was actually running (the
      // channel paused) never gets consumed -- it must expire instead of
      // reaching forward to cancel a later, unrelated turn. Surface that
      // honestly rather than leaving Stop showing as if it's still trying.
      if (body?.status === "expired") {
        setNotice("Nothing was running to stop.");
        break;
      }
    }
    finish();
  }

  /**
   * Shared Live Sessions hand-off: deliberately just a courtesy chat notice,
   * not a lock/transfer -- Stop and redirect were already open to anyone in
   * the channel before this feature existed (confirmed by reading the
   * existing onStop wiring above, which has never been sender-gated), so
   * there is no "control" to formally hand over. This only makes the
   * moment visible: a plain message, parented to the live turn, posted
   * through the same human message path everything else in this composer
   * uses.
   */
  async function requestHandOff(conversationId: string, messageId: string) {
    await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Stepped back from this session — anyone can pick it up.", parentMessageId: messageId }),
    }).catch(() => setNotice("Could not post the hand-off notice."));
  }

  async function toggleReaction(message: ConversationMessage, emoji: string) {
    if (!selected) return;
    const response = await fetch(`/api/dashboard/conversations/${encodeURIComponent(selected.id)}/reactions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: message.id, emoji }) });
    if (!response.ok) { setNotice("That reaction could not be saved."); return; }
    const result = await response.json() as { active?: boolean };
    setConversations((current) => current.map((conversation) => conversation.id !== selected.id ? conversation : {
      ...conversation,
      messages: conversation.messages.map((item) => item.id !== message.id ? item : {
        ...item,
        reactions: result.active
          ? [...item.reactions, { id: `local-${Date.now()}`, message_id: item.id, emoji, actor_user_id: "current-user", actor_connection_id: null }]
          : item.reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.actor_user_id === "current-user")),
      }),
    }));
  }

  async function editMessage(message: ConversationMessage) {
    const next = window.prompt("Edit message", message.body);
    if (next === null || !next.trim() || !selected) return;
    const response = await fetch(`/api/dashboard/conversations/${encodeURIComponent(selected.id)}/messages`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: message.id, body: next }) });
    if (!response.ok) { setNotice("That message could not be edited."); return; }
    setConversations((current) => current.map((conversation) => conversation.id !== selected.id ? conversation : { ...conversation, messages: conversation.messages.map((item) => item.id === message.id ? { ...item, body: next.trim(), edited_at: new Date().toISOString() } : item) }));
  }

  async function confirmDeleteMessage() {
    const message = confirmDeleteMessageTarget;
    if (!selected || !message) { setConfirmDeleteMessageTarget(null); return; }
    setDeletingMessage(true);
    try {
      const response = await fetch(`/api/dashboard/conversations/${encodeURIComponent(selected.id)}/messages?messageId=${encodeURIComponent(message.id)}`, { method: "DELETE" });
      if (!response.ok) { setNotice("That message could not be deleted."); return; }
      setConversations((current) => current.map((conversation) => conversation.id !== selected.id ? conversation : { ...conversation, messages: conversation.messages.map((item) => item.id === message.id ? { ...item, body: "[Message deleted]", deleted_at: new Date().toISOString(), edited_at: null } : item) }));
    } finally {
      setDeletingMessage(false);
      setConfirmDeleteMessageTarget(null);
    }
  }

  /** markAll is resolved server-side by predicate, so this clears every
   *  unread row for the user -- including the ones past the 100-row page
   *  this client holds. The optimistic update can only touch what is
   *  loaded; the next 5s poll reconciles the rest. */
  async function markAllNotificationsRead() {
    setNotifications((current) => current.map((item) => item.read_at ? item : { ...item, read_at: new Date().toISOString() }));
    setUnreadNotificationCount(0);
    await fetch("/api/dashboard/notifications", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markAll: true }) }).catch(() => undefined);
  }

  async function openNotification(notification: NotificationItem) {
    if (!notification.read_at) {
      await fetch("/api/dashboard/notifications", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ notificationIds: [notification.id] }) }).catch(() => undefined);
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item));
      setUnreadNotificationCount((current) => Math.max(0, current - 1));
    }
    if (notification.conversation_id) selectConversation(notification.conversation_id);
    setShowInbox(false);
  }

  return (
    <section
      className="wf-chat-shell"
      aria-label="Workspace collaboration"
      style={{ "--wf-side-w": `${sidePanelResize.width}px`, "--wf-file-w": `${filePanelResize.width}px` } as CSSProperties}
    >
      <div className="wf-chat-main">
        {mainOverlay ?? (showInbox ? <section className="wf-chat-inbox"><header className="wf-chat-header"><div><h2>Inbox</h2><p>Mentions, replies, and agent activity</p></div><div className="wf-chat-actions">{unreadNotificationCount > 0 && <button type="button" onClick={() => void markAllNotificationsRead()}>Mark all read</button>}<button type="button" onClick={() => setShowInbox(false)}>Back to channel</button></div></header>{notifications.length === 0 && <p className="wf-chat-empty">Nothing needs your attention.</p>}{notifications.map((notification) => <button type="button" key={notification.id} className={`wf-chat-notification ${notification.read_at ? "is-read" : ""}`} onClick={() => void openNotification(notification)}><strong>{notification.title}</strong><span>{notification.body}</span><time>{relativeTime(notification.created_at, now)}</time></button>)}</section> : terminalActive && selected ? (
          <TerminalWorkspace
            channelLabel={selected.channel_kind === "dm" ? channelDisplayName(selected) : `#${channelDisplayName(selected)}`}
            sessions={ptyRoomSessions}
            sendFrame={sendTerminalFrame}
            subscribeFrames={subscribePtyFrames}
            onBackToChat={() => setTerminalActive(false)}
            viewerParticipantId={viewerParticipantId}
            roster={channelRoster}
          />
        ) : selected ? (
          <>
            {/* The open channel's name used to be legible only as the
                highlighted row in this panel's own sidebar. That sidebar now
                lives in the primary nav (ProductShell), so the feed carries
                its own identity. Search and the Inbox used to live here too
                -- search is gone outright (unused), and Inbox moved into the
                composer toolbar, deprioritized but not deleted. Files and
                Ready for Review now live here instead, as icon toggles for
                the one side-panel slot (see AgentWorkspaceClient's
                sidePanelMode) -- both used to be buried in a "more actions"
                dropdown or a full-screen modal; this is the one consistent
                mechanism for both. */}
            <header className="m9r-channel-header">
              <div className="min-w-0 m9r-channel-heading">
                <h2>{channelDisplayName(selected)}</h2>
                {selected.description && <p>{selected.description}</p>}
              </div>
            </header>
            <nav className="m9r-channel-dock" aria-label="Channel panels">
              {onOpenReview && (
                <button type="button" className="m9r-channel-dock__item" data-active={reviewActive} onClick={onOpenReview} aria-pressed={reviewActive} aria-label={pendingReviewCount ? `Ready for Review, ${pendingReviewCount} pending` : "Ready for Review"}>
                  Review{Boolean(pendingReviewCount) && <b aria-hidden>{pendingReviewCount! > 99 ? "99+" : pendingReviewCount}</b>}
                </button>
              )}
              {onOpenWhispers && (
                <button type="button" className="m9r-channel-dock__item" data-active={whispersActive} onClick={onOpenWhispers} aria-pressed={whispersActive} aria-label="Agent Whispers">
                  Whispers
                </button>
              )}
              {onOpenDrafts && (
                <button type="button" className="m9r-channel-dock__item" data-active={draftsActive} onClick={onOpenDrafts} aria-pressed={draftsActive} aria-label="Shared Drafts">
                  Drafts
                </button>
              )}
              {onOpenPeople && (
                <button type="button" className="m9r-channel-dock__item" data-active={peopleActive} onClick={onOpenPeople} aria-pressed={peopleActive} aria-label="People">
                  People
                </button>
              )}
              {onOpenLive && (
                <button type="button" className="m9r-channel-dock__item" data-active={liveActive} onClick={onOpenLive} aria-pressed={liveActive} aria-label="Live Sessions">
                  Live
                </button>
              )}
              {onOpenHandoffs && (
                <button type="button" className="m9r-channel-dock__item" data-active={handoffsActive} onClick={onOpenHandoffs} aria-pressed={handoffsActive} aria-label="Goal Handoffs">
                  Handoffs
                </button>
              )}
              {TERMINAL_ENABLED && (
                <button type="button" className="m9r-channel-dock__item" data-active={terminalActive} onClick={() => setTerminalActive(true)} aria-pressed={terminalActive} aria-label="Terminal">
                  Terminal
                </button>
              )}
            </nav>
            <ol ref={messagesListRef} className="wf-chat-messages scrollbar-thin" data-verbosity={verbosity}>
              {/* Step groups now render inline, per-message, right where
                  MessageTodoList already does -- see stepGroupByMessageId
                  above. liveActivity (the coarser, older signal) still gets
                  a top-of-feed fallback, but only once, and only while
                  there's no per-message step data to show instead. */}
              {stepGroups.length === 0 && liveActivity.slice(0, 12).map((item) => <li key={`activity-${item.id}`} className="wf-chat-activity-card"><span className="wf-chat-activity-dot" aria-hidden /> <div><strong>{item.summary}</strong><small>{item.occurred_at ? relativeTime(item.occurred_at, now) : "live"}</small></div></li>)}
              {liveActivity.length === 0 && stepGroups.length === 0 && relayStatus !== "subscribed" && (
                <li className="wf-chat-activity-card" data-status={relayHttpFallback ? "fallback" : relayStatus}>
                  <span className="wf-chat-activity-dot" aria-hidden />
                  <div><strong>{relayHttpFallback ? "Live activity is unavailable" : relayStatus === "error" ? "Live relay is unavailable" : "Connecting to live activity"}</strong><small>{relayHttpFallback ? "Messages remain available through the HTTP fallback." : relayStatus === "error" ? relayErrorMessage ?? "Workspace relay connection failed." : "Activity will appear after the workspace relay subscribes."}</small></div>
                </li>
              )}
              <ChannelWelcome channelKey={`${workspaceId ?? "workspace"}:${viewerUserId ?? "viewer"}:${selected.id}`} hasMessages={selected.messages.length > 0} hasConfirmedMessages={selected.messages.some(message => !message.sendStatus)} />
              {(() => {
                const dividerIndex = unreadBoundary && unreadBoundary.conversationId === selected.id
                  ? selected.messages.findIndex((message) => message.id === unreadBoundary.messageId)
                  : -1;
                return groupMessages(selected.messages).map(({ message, isGroupStart, isNewDay }, index) => {
                const showUnreadDivider = dividerIndex !== -1 && index === dividerIndex;
                const isHuman = Boolean(message.sender_user_id);
                const isViewer = isHuman && Boolean(viewerUserId) && message.sender_user_id === viewerUserId;
                const senderName = isViewer ? "Me" : isHuman ? message.sender_display_name ?? "Teammate" : message.sender_display_name ?? labelFor(message.sender_connection_id);
                /* Sender labels are viewer-relative: only the authenticated
                   author's own rows say "Me". Other humans keep their stored
                   display name, even when the message mentions the viewer. */
                const senderAgent = message.sender_connection_id ? byConnectionId.get(message.sender_connection_id) ?? null : null;
                // A directed agent-to-agent message (recipient_connection_id set,
                // not a channel broadcast) -- the real mechanism the Whispers
                // panel already reads, previously invisible here: it rendered as
                // an indistinguishable plain bubble. Only worth a routed badge
                // when the recipient is another AGENT; a human recipient is
                // already legible as a normal reply/mention.
                const recipientAgent = senderAgent && message.recipient_connection_id ? byConnectionId.get(message.recipient_connection_id) ?? null : null;
                const pills = reactionPills(message);
                const resolvedCard = resolvedCards[message.id];
                return (
                <li key={message.id} id={`message-${message.id}`}>
                  {isNewDay && <div className="wf-chat-day-divider" role="separator"><span>{dayLabel(message.created_at, now)}</span></div>}
                  {showUnreadDivider && <div className="wf-chat-unread-divider" role="separator"><span>New</span></div>}
                  {/* D1 identity rule: humans get sans, machines get mono --
                      agent messages get a 2px brand-colored left accent and
                      their mono @handle; the sender name itself stays sans
                      either way (a name is a human-facing label, not a
                      machine fact). */}
                  {/* D2: handoff/ack/result are structurally different events
                      from a chat message -- a control handoff or a run
                      result deserves a shape you can recognize without
                      reading the text, not just the same row with a small
                      gray label appended. */}
                  <div
                    className={`wf-chat-message ${message.parent_message_id ? "is-reply" : ""} ${isGroupStart ? "" : "is-grouped"}`}
                    data-sender-agent={senderAgent?.key}
                    data-kind={message.kind !== "message" ? message.kind : undefined}
                    data-outcome={message.kind === "result" ? message.outcome ?? undefined : undefined}
                    /* Viewer-relative alignment, the way any texting app
                       reads: only the authenticated viewer's own messages
                       are "mine" and sit on the right in the accent color;
                       everyone else -- another human teammate or an agent --
                       is "theirs" and sits on the left. Never derived from
                       message.kind or sender type, only from isViewer. */
                    data-mine={isViewer || undefined}
                  >
                    {isGroupStart
                      ? senderAgent
                        ? <span className="wf-chat-avatar is-agent" title={senderAgent.label}><AgentMark agentKey={senderAgent.key} size={28} /></span>
                        : <div className="wf-chat-avatar" data-agent="false">{initialsFor(senderName)}</div>
                      : <time className="wf-chat-grouped-time ol-mono" dateTime={message.created_at}>{absoluteTime(message.created_at, now)}</time>}
                    <div className="wf-chat-message-body">
                      {isGroupStart && (
                        <div className="wf-chat-message-meta">
                          <strong>{senderName}</strong>
                          {/* The rebranded display label ("Claude"), never the raw
                              provider key ("claude-code") -- the key still backs
                              real @mention matching elsewhere, this is display-only. */}
                          {senderAgent && <span className="wf-chat-message-handle ol-mono">@{senderAgent.label}</span>}
                          <time className="ol-mono">{absoluteTime(message.created_at, now)}</time>
                          {(message.kind !== "message" || message.edited_at) && (
                            <span className="ol-mono">{message.kind !== "message" ? KIND_LABEL[message.kind] : ""}{message.edited_at ? " · edited" : ""}</span>
                          )}
                        </div>
                      )}
                      {/* The quoted reply-preview: a reply is a distinct act
                          from "the next message in the feed", so it gets its
                          own visible pointer back to what it answered --
                          sender + a truncated snippet, the iMessage/WhatsApp
                          idiom -- instead of relying on feed order alone.
                          Clicking it jumps to and highlights the original. */}
                      {message.parent_message_id && (() => {
                        const parentMessage = messagesById.get(message.parent_message_id!);
                        if (!parentMessage) return null;
                        const parentIsViewer = Boolean(parentMessage.sender_user_id) && Boolean(viewerUserId) && parentMessage.sender_user_id === viewerUserId;
                        const parentSenderName = parentIsViewer ? "You" : parentMessage.sender_user_id ? parentMessage.sender_display_name ?? "Teammate" : parentMessage.sender_display_name ?? labelFor(parentMessage.sender_connection_id);
                        const snippet = parentMessage.body.length > 120 ? `${parentMessage.body.slice(0, 120)}…` : parentMessage.body;
                        return (
                          <button type="button" className="wf-chat-reply-quote" onClick={() => scrollToMessage(parentMessage.id)}>
                            <span className="wf-chat-reply-quote-bar" aria-hidden />
                            <span className="wf-chat-reply-quote-text">
                              <strong>{parentSenderName}</strong>
                              <span>{snippet}</span>
                            </span>
                          </button>
                        );
                      })()}
                      {/* A notice with an attached approval card (evidence
                          request, run-start, finding, rule draft,
                          permission) already restates its own request in the
                          card's subject/detail box below -- printing the raw
                          notice body too was pure duplication of the same
                          sentence, once as plain text and once inside the
                          card. */}
                      {/* Delegation card: a directed agent-to-agent message
                          (recipientAgent set) is a structurally different
                          event from a broadcast chat message, so it gets a
                          structurally different shape -- a routed, bounded
                          object, not a plain bubble. This is the real
                          Whispers data (recipient_connection_id), previously
                          only readable in that separate side panel, now
                          visible in the main feed. Deliberately no
                          fabricated "done/running" status chip here -- the
                          schema has no per-message completion state, and
                          item #4's real task-contract object (with a genuine
                          status) doesn't exist yet. Showing an invented
                          status would be a fake signal, not a design choice. */}
                      {recipientAgent ? (
                        <div className="wf-chat-route-card">
                          <div className="wf-chat-route-card-header">
                            <span className="wf-chat-route-card-agent" style={{ color: AGENT_BRAND_COLOR[senderAgent!.key] ?? "var(--ol-text-primary)" }}>
                              <AgentMark agentKey={senderAgent!.key} size={14} />
                              {senderAgent!.label}
                            </span>
                            <span className="wf-chat-route-arrow" aria-hidden>→</span>
                            <span className="wf-chat-route-card-agent" style={{ color: AGENT_BRAND_COLOR[recipientAgent.key] ?? "var(--ol-text-primary)" }}>
                              <AgentMark agentKey={recipientAgent.key} size={14} />
                              {recipientAgent.label}
                            </span>
                          </div>
                          <MessageBody body={message.body} className="wf-chat-route-card-body" />
                        </div>
                      ) : (
                        !(message.kind === "notice" && (resolvedCard || evidenceRequestByMessageId.has(message.id) || runStartApprovalByMessageId.has(message.id) || findingByMessageId.has(message.id) || ruleDraftByMessageId.has(message.id) || permissionByMessageId.has(message.id) || evidenceSubmissionByMessageId.has(message.id))) && <MessageBody body={message.body} />
                      )}
                      {queuedMessageIds.has(message.id) && <span className="wf-chat-queued-pill">Queued — runs after current turn</span>}
                      {message.sendStatus && <SendStatusIndicator message={message} onRetry={retrySend} />}
                      {/* A "View run →" deep-link lived here, pointing at
                          /dashboard/runs/[id]. That page was cut; the card
                          below already carries the run's task, status and
                          timestamp inline, so nothing replaces it. */}
                      {resolvedCard && <ResolvedApprovalCard record={resolvedCard} nowMs={now} />}
                      {!resolvedCard && evidenceRequestByMessageId.has(message.id) && (() => {
                        const request = evidenceRequestByMessageId.get(message.id)!;
                        const busy = evidenceDecisionBusyId === request.id;
                        return (
                          <div className="wf-chat-approval-card" role="group" aria-label="Approval required">
                            <div className="wf-chat-approval-card-header">
                              <span className="wf-chat-approval-card-dot" aria-hidden />
                              APPROVAL REQUIRED
                            </div>
                            <div className="wf-chat-approval-card-subject">
                              {senderAgent && <AgentMark agentKey={senderAgent.key} size={16} />}
                              <strong>{senderName}</strong>&nbsp;wants to submit evidence
                            </div>
                            <div className="wf-chat-approval-card-detail-box">{request.requestSummary}</div>
                            <div className="wf-chat-approval-card-actions">
                              <button type="button" className="wf-chat-approval-approve" disabled={busy} onClick={() => void decideEvidenceRequest(request.id, true)}>
                                {busy ? "…" : "Approve"}
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decideEvidenceRequest(request.id, false)}>
                                Reject
                              </button>
                              <span className="wf-chat-approval-card-meta ol-mono">#{selected.topic.toLowerCase().replace(/\s+/g, "-")}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {!resolvedCard && runStartApprovalByMessageId.has(message.id) && (() => {
                        const approval = runStartApprovalByMessageId.get(message.id)!;
                        const busy = runStartDecisionBusyId === approval.id;
                        return (
                          <div className="wf-chat-approval-card" role="group" aria-label="Approval required">
                            <div className="wf-chat-approval-card-header">
                              <span className="wf-chat-approval-card-dot" aria-hidden />
                              APPROVAL REQUIRED
                              <ExpiryCountdownText expiresAt={approval.expiresAt} />
                            </div>
                            <div className="wf-chat-approval-card-subject">
                              {senderAgent && <AgentMark agentKey={senderAgent.key} size={16} />}
                              <strong>{senderName}</strong>&nbsp;wants to run a command
                            </div>
                            {approval.sensitiveAreas.length > 0 && (
                              <p className="wf-chat-approval-card-warning">
                                ⚠ Touches {approval.sensitiveAreas.join(", ")} · {approval.riskClassification} risk · requires human sign-off
                              </p>
                            )}
                            <div className="wf-chat-approval-card-actions">
                              <button type="button" className="wf-chat-approval-approve" disabled={busy} onClick={() => void decideRunStartApproval(approval.id, true)}>
                                {busy ? "…" : "Approve"}
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decideRunStartApproval(approval.id, false)}>
                                Reject
                              </button>
                              <span className="wf-chat-approval-card-meta ol-mono">{approval.riskClassification} risk · #{selected.topic.toLowerCase().replace(/\s+/g, "-")}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {!resolvedCard && findingByMessageId.has(message.id) && (() => {
                        const finding = findingByMessageId.get(message.id)!;
                        const busy = findingDecisionBusyId === finding.id;
                        return (
                          <div className="wf-chat-approval-card" role="group" aria-label="Review required">
                            <div className="wf-chat-approval-card-header">
                              <span className="wf-chat-approval-card-dot" aria-hidden />
                              FINDING REQUIRES REVIEW
                            </div>
                            <div className="wf-chat-approval-card-subject">
                              {senderAgent && <AgentMark agentKey={senderAgent.key} size={16} />}
                              <strong>{senderName}</strong>&nbsp;reported a finding
                            </div>
                            <div className="wf-chat-approval-card-detail-box">
                              <strong>{finding.title}</strong>
                              <p className="mt-1">{finding.observedBehavior}</p>
                            </div>
                            <div className="wf-chat-approval-card-actions">
                              <button type="button" className="wf-chat-approval-approve" disabled={busy} onClick={() => void decideFinding(finding.id, "promote")}>
                                {busy ? "…" : "Approve & suggest rule"}
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decideFinding(finding.id, "available")}>
                                Mark available
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decideFinding(finding.id, "retired")}>
                                Retire
                              </button>
                              <span className="wf-chat-approval-card-meta ol-mono">{finding.evidenceLevel} · #{selected.topic.toLowerCase().replace(/\s+/g, "-")}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {!resolvedCard && ruleDraftByMessageId.has(message.id) && (() => {
                        const draft = ruleDraftByMessageId.get(message.id)!;
                        const busy = ruleDraftDecisionBusyId === draft.id;
                        return (
                          <div className="wf-chat-approval-card" role="group" aria-label="Review required">
                            <div className="wf-chat-approval-card-header">
                              <span className="wf-chat-approval-card-dot" aria-hidden />
                              RULE DRAFT REQUIRES REVIEW
                            </div>
                            <div className="wf-chat-approval-card-subject">
                              <strong>{draft.title}</strong>
                            </div>
                            <div className="wf-chat-approval-card-detail-box">{draft.body}</div>
                            <div className="wf-chat-approval-card-actions">
                              <button type="button" className="wf-chat-approval-approve" disabled={busy} onClick={() => void decideRuleDraft(draft.id, true)}>
                                {busy ? "…" : "Promote to active"}
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decideRuleDraft(draft.id, false)}>
                                Discard draft
                              </button>
                              <span className="wf-chat-approval-card-meta ol-mono">#{selected.topic.toLowerCase().replace(/\s+/g, "-")}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {!resolvedCard && permissionByMessageId.has(message.id) && (() => {
                        const permission = permissionByMessageId.get(message.id)!;
                        const busy = permissionDecisionBusyId === permission.id;
                        return (
                          <div className="wf-chat-approval-card" role="group" aria-label="Approval required">
                            <div className="wf-chat-approval-card-header">
                              <span className="wf-chat-approval-card-dot" aria-hidden />
                              APPROVAL REQUIRED
                            </div>
                            <div className="wf-chat-approval-card-subject">
                              {senderAgent && <AgentMark agentKey={senderAgent.key} size={16} />}
                              <strong>{senderName}</strong>&nbsp;wants permission
                            </div>
                            <div className="wf-chat-approval-card-detail-box">
                              {permission.summary}
                              {permission.command && <p className="ol-mono mt-1">$ {permission.command}</p>}
                              {permission.filePath && <p className="ol-mono mt-1">{permission.filePath}</p>}
                            </div>
                            <div className="wf-chat-approval-card-actions">
                              <button type="button" className="wf-chat-approval-approve" disabled={busy} onClick={() => void decidePermission(permission.id, true)}>
                                {busy ? "…" : "Approve"}
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decidePermission(permission.id, false)}>
                                Deny
                              </button>
                              <span className="wf-chat-approval-card-meta ol-mono">#{selected.topic.toLowerCase().replace(/\s+/g, "-")}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {!resolvedCard && evidenceSubmissionByMessageId.has(message.id) && (() => {
                        const submission = evidenceSubmissionByMessageId.get(message.id)!;
                        const busy = evidenceSubmissionDecisionBusyId === submission.id;
                        return (
                          <div className="wf-chat-approval-card" role="group" aria-label="Evidence review required">
                            <div className="wf-chat-approval-card-header">
                              <span className="wf-chat-approval-card-dot" aria-hidden />
                              EVIDENCE REVIEW REQUIRED
                            </div>
                            <div className="wf-chat-approval-card-subject">
                              {submission.provider && <span className="ol-mono">{submission.provider}</span>}
                            </div>
                            <div className="wf-chat-approval-card-detail-box">
                              <strong>{submission.summary}</strong>
                              {submission.evidence && (
                                <div className="mt-2 space-y-1.5 text-[length:var(--ol-text-2xs)]">
                                  <div><strong>Work:</strong> {submission.evidence.work.join(" · ")}</div>
                                  <div><strong>Files / sources:</strong> {submission.evidence.files.join(" · ")}</div>
                                  <div><strong>Verification:</strong> {submission.evidence.verification.map((item) => `${item.command} → ${item.result}`).join(" · ")}</div>
                                  {submission.evidence.limitations.length > 0 && <div><strong>Limitations:</strong> {submission.evidence.limitations.join(" · ")}</div>}
                                </div>
                              )}
                            </div>
                            <div className="wf-chat-approval-card-actions">
                              <button type="button" className="wf-chat-approval-approve" disabled={busy} onClick={() => void decideEvidenceSubmission(submission.id, true)}>
                                {busy ? "…" : "Approve"}
                              </button>
                              <button type="button" className="wf-chat-approval-reject" disabled={busy} onClick={() => void decideEvidenceSubmission(submission.id, false)}>
                                Reject
                              </button>
                              <span className="wf-chat-approval-card-meta ol-mono">#{selected.topic.toLowerCase().replace(/\s+/g, "-")}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {taskContractByAnchorMessageId.has(message.id) && (
                        <TaskCard
                          contract={taskContractByAnchorMessageId.get(message.id)!}
                          byConnectionId={byConnectionId}
                          nowMs={now}
                          onJumpToMessage={scrollToMessage}
                        />
                      )}
                      {(() => {
                        // A-6, corrected: this used to render as one block
                        // pinned above the ENTIRE scrolled feed regardless of
                        // where the triggering message actually was, which
                        // made it invisible in any channel with more than one
                        // screen of history -- a human at the bottom, where
                        // the live conversation actually is, would never see
                        // it without scrolling all the way up. It now renders
                        // right here, on the exact message whose turn it
                        // belongs to, the same place MessageTodoList already
                        // anchors its own live state.
                        const group = stepGroupByMessageId.get(message.id);
                        if (!group) return null;
                        const label = group.steps[0]?.connectionId ? labelFor(group.steps[0].connectionId) : "Agent";
                        return <StepGroupCard group={group} label={label} verbosity={verbosity} />;
                      })()}
                      {(() => {
                        // Live revision wins over the persisted row for the
                        // same (message, connection); anything the relay has
                        // not spoken about is still shown from what was
                        // stored, which is exactly what makes this survive a
                        // reload instead of reading as a transient ping.
                        const live = Object.values(liveTodos).filter((todo) => todo.message_id === message.id);
                        const persisted = message.todos.filter((todo) => !live.some((item) => item.connection_id === todo.connection_id));
                        const todos = [...persisted, ...live].sort((left, right) => left.connection_id.localeCompare(right.connection_id));
                        if (todos.length === 0) return null;
                        return todos.map((todo) => (
                          <MessageTodoList key={`todo-${todo.connection_id}`} todo={todo} label={labelFor(todo.connection_id)} nowMs={now} />
                        ));
                      })()}
                      {message.attachments.length > 0 && (
                        <div className="wf-chat-attachments">
                          {message.attachments.map((attachment) => (
                            attachment.mediaType.startsWith("image/") ? (
                              <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="wf-chat-attachment-image">
                                {/* Attachments may come from user-scoped storage domains; next/image cannot safely optimize arbitrary URLs here. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={attachment.url} alt={attachment.name} />
                              </a>
                            ) : (
                              <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="wf-chat-attachment-file">
                                <AttachIcon size={13} />
                                <span>{attachment.name}</span>
                                <small className="ol-mono">{(attachment.sizeBytes / 1024).toFixed(0)} KB</small>
                              </a>
                            )
                          ))}
                        </div>
                      )}
                      {pills.length > 0 && (
                        <div className="wf-chat-reaction-pills">
                          {pills.map((pill) => (
                            <button key={pill.emoji} type="button" className="wf-chat-reaction-pill" data-mine={pill.mine} onClick={() => void toggleReaction(message, pill.emoji)}>{pill.emoji} {pill.count}</button>
                          ))}
                        </div>
                      )}
                      {!message.parent_message_id && replyCountByRootId.has(message.id) && (() => {
                        const thread = replyCountByRootId.get(message.id)!;
                        return (
                          <button type="button" className="wf-chat-thread-summary" onClick={() => setReplyTargetId(message.id)}>
                            <span className="wf-chat-thread-summary-count">{thread.count} repl{thread.count === 1 ? "y" : "ies"}</span>
                            <span className="wf-chat-thread-summary-time">Last reply {relativeTime(thread.lastRepliedAt, now)}</span>
                          </button>
                        );
                      })()}
                      <div className="wf-chat-message-tools">
                        <button type="button" onClick={() => void toggleReaction(message, "👍")} title="React 👍" aria-label="React with thumbs up">👍</button>
                        <button type="button" onClick={() => void toggleReaction(message, "✅")} title="React ✅" aria-label="React with checkmark">✅</button>
                        <button type="button" onClick={() => setReplyTargetId(message.id)} title={message.parent_message_id ? "Reply" : "Thread"} aria-label={message.parent_message_id ? "Reply" : "Start thread"}><Reply size={13} aria-hidden /></button>
                        {message.sender_user_id && (
                          <>
                            <button type="button" onClick={() => void editMessage(message)} title="Edit" aria-label="Edit message"><Pencil size={13} aria-hidden /></button>
                            <button type="button" className="is-danger" onClick={() => setConfirmDeleteMessageTarget(message)} title="Delete" aria-label="Delete message"><Trash2 size={13} aria-hidden /></button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
                );
                });
              })()}
            </ol>
            {threadRoot && <aside className="wf-chat-thread" aria-label="Message thread"><header><strong>Thread</strong><button type="button" onClick={() => setReplyTargetId(null)}>Close</button></header><p>{threadRoot.body}</p><small>{threadReplies.length} repl{threadReplies.length === 1 ? "y" : "ies"}</small>{threadReplies.map((reply) => { const replyIsViewer = Boolean(viewerUserId) && reply.sender_user_id === viewerUserId; return <div key={reply.id}><strong>{replyIsViewer ? "Me" : reply.sender_user_id ? reply.sender_display_name ?? "Teammate" : reply.sender_display_name ?? labelFor(reply.sender_connection_id)}</strong><span>{reply.body}</span></div>; })}</aside>}
            <BorderBeam className="m9r-composer-beam" size="md" colorVariant="mono" strength={0.65} active theme="auto">
            <form className="wf-chat-composer" onSubmit={submit}>
              {replyTargetId && <div className="wf-chat-reply-context">Replying in thread <button type="button" onClick={() => setReplyTargetId(null)}>Cancel</button></div>}
              {interjectFor && (
                <div className="wf-chat-interject-context" role="status">
                  Stopped {interjectFor.label}. What should it do instead? Anyone here can reply.
                  <button type="button" onClick={() => setInterjectFor(null)}>Dismiss</button>
                </div>
              )}
              {routeSuggestion && (
                <div className="wf-chat-interject-context" role="status">
                  This looks like a multi-step task and {routeSuggestion.agent.label} is set to a {tierLabel(routeSuggestion.tier)} model. Consider switching it to something stronger before sending.
                  <button type="button" onClick={() => setRouteSuggestionDismissed(true)}>Dismiss</button>
                </div>
              )}
              {/* Real chip row for every agent currently @-mentioned in the
                  draft -- resolves the raw handle to its actual mark + the
                  rebranded display label ("Claude", not "@claude-code"),
                  instead of the plain colored-text highlight being the only
                  feedback a mention even landed. Approved design pass. */}
              {mentionedAgentsInDraft.length > 0 && (
                <div className="wf-chat-mention-chip-row">
                  {mentionedAgentsInDraft.map((agent) => (
                    <span key={agent.id} className="wf-chat-mention-chip">
                      <AgentMark agentKey={agent.key} size={16} />
                      {agent.label}
                    </span>
                  ))}
                </div>
              )}
              <div ref={composerFieldRef} className="wf-chat-composer-field">
                {mentionMenuRect && typeof document !== "undefined" && createPortal(
                  <div
                    className="wf-chat-mention-menu wf-chat-mention-menu--floating"
                    role="listbox"
                    aria-label="Mention an agent"
                    style={{ left: mentionMenuRect.left, bottom: mentionMenuRect.bottom, width: Math.min(320, Math.max(220, mentionMenuRect.width)) }}
                  >
                    {mentionSuggestions.map((agent, index) => (
                      <button
                        key={agent.id}
                        type="button"
                        role="option"
                        aria-selected={index === activeMentionIndex}
                        className={index === activeMentionIndex ? "is-active" : ""}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setMentionActiveIndex(index)}
                        onClick={() => { selectMention(agent); textareaRef.current?.focus(); }}
                      >
                        <i data-live={agent.connected ? "true" : "false"} aria-hidden />
                        <span className="wf-chat-mention-name">{agent.label}</span>
                        <small>{agent.connected ? "online" : "offline"}</small>
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
                {shortcutMenuOpen && slashSuggestions.length > 0 && (
                  <div className="wf-chat-shortcut-menu" role="listbox" aria-label="Message types">
                    {slashSuggestions.map((shortcut) => (
                      <button key={shortcut.prefix} type="button" onClick={() => applyShortcut(shortcut.prefix)}>
                        <span className="wf-chat-mention-name">{shortcut.prefix}</span>
                        <small>{shortcut.hint}</small>
                      </button>
                    ))}
                  </div>
                )}
                {/* Inline @mention highlighting as you type, matching the
                    blue-pill-on-typed-@Claude idiom from Claude Tag's own
                    video (docs/research-claude-tag-ui-deep-dive.md, Section
                    5.4) -- previously M9R only had the suggestion
                    dropdown, with no feedback in the draft text itself once
                    a mention was actually typed. A backdrop div behind the
                    (already-transparent-background) textarea, pixel-aligned
                    and scroll-synced, since a plain <textarea> can't render
                    rich inline spans on its own. */}
                <div ref={mentionHighlightRef} className="wf-chat-mention-highlight-backdrop scrollbar-thin" aria-hidden="true">
                  {renderHighlightedDraft(draft, agentMentionKeys)}
                </div>
                <textarea
                  ref={textareaRef}
                  className="scrollbar-thin"
                  aria-label={`Message #${selected.topic}`}
                  value={draft}
                  onKeyDown={handleComposerKeyDown}
                  onScroll={(event) => { if (mentionHighlightRef.current) mentionHighlightRef.current.scrollTop = event.currentTarget.scrollTop; }}
                  onChange={(event) => { const value = event.target.value; setDraft(value); if (value.trim()) { void relayRef.current?.setTyping(true); if (typingTimerRef.current) clearTimeout(typingTimerRef.current); typingTimerRef.current = setTimeout(() => { void relayRef.current?.setTyping(false); }, 3_000); } else void relayRef.current?.setTyping(false); }}
                  placeholder={`${replyTargetId ? "Reply" : "Message"} #${selected.topic.toLowerCase().replace(/\s+/g, "-")}`}
                  maxLength={2000}
                />
              </div>
              <div className="wf-chat-composer-toolbar">
                <div className="wf-chat-composer-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    hidden
                    accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,application/json,audio/mpeg,audio/ogg,audio/wav"
                    onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachFile(file); event.target.value = ""; }}
                  />
                  <button type="button" className="wf-chat-toolbar-icon" aria-label="Attach a file" title="Attach a file" disabled={uploadingAttachment} onClick={() => fileInputRef.current?.click()}>
                    {uploadingAttachment ? <span className="wf-chat-send-spinner" aria-hidden /> : <AttachIcon size={15} />}
                  </button>
                  <button type="button" className="wf-chat-toolbar-icon" aria-label="Mention an agent" title="Mention an agent" onClick={insertMentionTrigger}>
                    <MentionIcon size={15} />
                  </button>
                  {/* B-4's global verbosity control, moved off the message
                      feed and into the composer toolbar -- same idiom as
                      attach/mention, not a second floating control competing
                      with the feed for attention. */}
                  <div className="wf-chat-verbosity" ref={verbosityMenuRef}>
                    <button
                      type="button"
                      className="wf-chat-toolbar-icon"
                      aria-label={`Transcript detail: ${VERBOSITY_LABEL[verbosity]}`}
                      title={`Transcript detail: ${VERBOSITY_LABEL[verbosity]}`}
                      aria-haspopup="menu"
                      aria-expanded={verbosityMenuOpen}
                      onClick={() => setVerbosityMenuOpen((value) => !value)}
                    >
                      <SlidersHorizontal size={15} />
                    </button>
                    {verbosityMenuOpen && (
                      <div className="wf-chat-verbosity-menu" role="menu" aria-label="Transcript detail">
                        {(["normal", "verbose", "summary"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            role="menuitemradio"
                            aria-checked={verbosity === mode}
                            className="wf-chat-verbosity-menu-item"
                            onClick={() => { setVerbosity(mode); setVerbosityMenuOpen(false); }}
                          >
                            {VERBOSITY_LABEL[mode]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Deprioritized out of the chat header (Files and Ready
                      for Review took that spot), not deleted -- kept
                      reachable here for later, same idiom as the other
                      composer toolbar icons. */}
                  <button type="button" className="wf-chat-toolbar-icon" onClick={() => setShowInbox(true)} aria-label={unreadNotificationCount > 0 ? `Inbox, ${unreadNotificationCount} unread` : "Inbox"} title="Inbox">
                    <InboxIcon size={15} />
                    {unreadNotificationCount > 0 && <b aria-hidden>{unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}</b>}
                  </button>
                </div>
                <div className="wf-chat-composer-status">
                  {draft.length > 1_800 && <span className="wf-chat-char-count" data-warn={draft.length > 1_950}>{draft.length}/2000</span>}
                  <span className="wf-chat-relay-indicator" data-status={relayStatus} data-error={relayErrorMessage ?? undefined} title={`Relay: ${relayStatusLabel(relayStatus, relayHttpFallback)}${relayErrorMessage ? ` (${relayErrorMessage})` : ""}`}>
                    <Circle size={7} strokeWidth={0} fill="currentColor" />
                    {relayStatusLabel(relayStatus, relayHttpFallback)}
                  </span>
                  {/* The composer's Stop only appears when exactly one turn
                      is running, because a single button cannot say which
                      agent it means -- AND only while the draft is empty:
                      the moment a human starts typing, this must revert to
                      Send so a next message can be queued while a turn is
                      still running, the same as Claude Code's and Codex's
                      own composers. Stop itself never disappears in that
                      case -- the per-agent liveness line below always carries
                      its own Stop now (see visibleTurns.map's onStop), so
                      showing Send here never leaves a running turn
                      unstoppable. With two agents working, each liveness
                      line below carries its own correctly-keyed Stop and
                      this reverts to Send regardless of the draft. */}
                  {soleRunningTurn && !draft.trim() ? (
                    <button
                      type="button"
                      className="wf-chat-send-button"
                      data-stop="true"
                      disabled={cancelingConnectionIds.includes(soleRunningTurn.connectionId)}
                      aria-label={`Stop ${labelFor(soleRunningTurn.connectionId)}'s current turn`}
                      title={cancelingConnectionIds.includes(soleRunningTurn.connectionId) ? "Stopping…" : `Stop ${labelFor(soleRunningTurn.connectionId)}'s current turn`}
                      onClick={() => void requestStopTurn(selected.id, soleRunningTurn.connectionId)}
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  ) : (
                    <button className="wf-chat-send-button" type="submit" disabled={!draft.trim()} aria-label="Send message">
                      <SendIcon size={16} />
                    </button>
                  )}
                </div>
              </div>
              {visibleTurns.map((turn) => (
                <AgentLivenessLine
                  key={turn.connectionId}
                  name={labelFor(turn.connectionId)}
                  turn={turn}
                  onStop={
                    !turn.confirmed || (soleRunningTurn?.connectionId === turn.connectionId && !draft.trim())
                      ? null
                      : () => void requestStopTurn(selected.id, turn.connectionId)
                  }
                  stopping={cancelingConnectionIds.includes(turn.connectionId)}
                  watcherIds={onlineParticipantIds}
                  roster={channelRoster}
                  onHandOff={turn.messageId ? () => void requestHandOff(selected.id, turn.messageId!) : null}
                />
              ))}
              {visibleTurns.length === 0 && typingParticipantIds.length > 0 && (
                <p className="wf-chat-typing">{typingParticipantIds.map((id) => labelFor(id)).join(", ")} {typingParticipantIds.length === 1 ? "is" : "are"} typing…</p>
              )}
            </form>
            </BorderBeam>
            {notice && (
              <div className="wf-chat-toast" role="alert">
                <span>{notice}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={12} aria-hidden /></button>
              </div>
            )}
          </>
        ) : <div className="wf-chat-empty"><div className="m9r-workspace-welcome"><h3>Select a channel.<br /><span>Keep every agent in context.</span></h3></div></div>)}
      </div>
      {sidePanel && (
        <>
          <PanelResizeHandle label="side" handleProps={sidePanelResize.handleProps} />
          <aside className="wf-chat-side-slot" aria-label="Side panel">{sidePanel}</aside>
        </>
      )}
      {filePanel && (
        <>
          <PanelResizeHandle label="Live Code" handleProps={filePanelResize.handleProps} />
          <aside className="wf-chat-file-slot" aria-label="Live file view">{filePanel}</aside>
        </>
      )}
      <ProductConfirmDialog
        open={confirmDeleteMessageTarget !== null}
        title="Delete this message?"
        description="This permanently removes it. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        busy={deletingMessage}
        onConfirm={() => void confirmDeleteMessage()}
        onCancel={() => setConfirmDeleteMessageTarget(null)}
      />
    </section>
  );
}
