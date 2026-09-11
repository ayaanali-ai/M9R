"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MissionConversationDto,
  MissionMessageDeliveryDto,
  MissionSummaryDto,
} from "@/lib/mission/mission-application-service";
import {
  buildMissionThreads,
  filterMissionMessages,
  mentionedParticipantIds,
  mentionHandle,
} from "@/lib/mission/mission-conversation-ui";

const MESSAGE_TYPES = ["information", "question", "answer", "review_request", "blocker", "evidence_notice", "completion_notice"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];

const shortId = (value: string) => value.length > 10 ? `${value.slice(0, 8)}…` : value;

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function apiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  return fallback;
}

export default function MissionConversationWorkspace({
  missionId,
  workspaceId,
  mission,
  viewerUserId,
}: {
  missionId: string;
  workspaceId: string;
  mission: MissionSummaryDto;
  viewerUserId: string | null;
}) {
  const [conversation, setConversation] = useState<MissionConversationDto | null>(null);
  const [deliveries, setDeliveries] = useState<MissionMessageDeliveryDto[]>([]);
  const [search, setSearch] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [messageType, setMessageType] = useState<MessageType>("information");
  const [directRecipientId, setDirectRecipientId] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [isTyping, setIsTyping] = useState(false);

  const refreshConversation = useCallback(async () => {
    const queryWorkspace = `&workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/conversation?limit=200${queryWorkspace}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(payload, "Could not load the mission conversation."));
    setConversation(payload.conversation as MissionConversationDto);
  }, [missionId, workspaceId]);

  const refreshDeliveries = useCallback(async () => {
    const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/deliveries?limit=500&workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(payload, "Could not load message delivery status."));
    setDeliveries(Array.isArray(payload.deliveries) ? payload.deliveries : []);
  }, [missionId, workspaceId]);

  const refreshNotifications = useCallback(async () => {
    const response = await fetch("/api/dashboard/notifications", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json().catch(() => ({})) as { unreadCount?: unknown };
    setUnreadNotifications(typeof payload.unreadCount === "number" ? payload.unreadCount : 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([refreshConversation(), refreshDeliveries(), refreshNotifications()]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the mission conversation.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const conversationTimer = window.setInterval(() => { void refreshConversation().catch(() => undefined); }, 10_000);
    const notificationTimer = window.setInterval(() => { void refreshNotifications(); }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(conversationTimer);
      window.clearInterval(notificationTimer);
    };
  }, [refreshConversation, refreshDeliveries, refreshNotifications]);

  useEffect(() => {
    // participant.typing is a local UI signal today; the durable message is
    // still the source of truth, so typing state never becomes a fake record.
    const participantTypingEvent = "participant.typing";
    function onTyping(event: Event) {
      const detail = (event as CustomEvent<{ missionId?: string; participantId?: string }>).detail;
      if (detail?.missionId === missionId) setIsTyping(Boolean(detail.participantId));
    }
    window.addEventListener(participantTypingEvent, onTyping);
    return () => window.removeEventListener(participantTypingEvent, onTyping);
  }, [missionId]);

  const participants = useMemo(() => conversation?.participants ?? [], [conversation?.participants]);
  const participantById = useMemo(() => new Map(participants.map((participant) => [participant.id, participant])), [participants]);
  // The viewer's own participant row is keyed by their user id (see
  // mission-application-service.ts:682-698). Matching by id, not just
  // "first human," is required once a Mission has more than one human
  // participant -- otherwise every viewer sends and reads as whoever
  // happens to sort first.
  const currentParticipant = (viewerUserId && participants.find((participant) => participant.kind === "human" && participant.id === viewerUserId))
    || participants.find((participant) => participant.kind === "human")
    || null;
  const filteredMessages = useMemo(
    () => filterMissionMessages(conversation?.messages ?? [], participants, search),
    [conversation?.messages, participants, search],
  );
  const threads = useMemo(() => buildMissionThreads(filteredMessages), [filteredMessages]);
  const selectedThread = threads.find((thread) => thread.root.id === selectedThreadId) ?? null;
  const activeDeliveryCount = deliveries.filter((delivery) => delivery.status !== "acknowledged").length;

  function handleComposerChange(value: string) {
    setReplyBody(value);
    setIsTyping(Boolean(value.trim()));
    window.dispatchEvent(new CustomEvent("participant.typing", {
      detail: { missionId, participantId: value.trim() ? currentParticipant?.id ?? null : null },
    }));
  }

  async function sendMessage() {
    const body = replyBody.trim();
    if (!body || sending || !currentParticipant) return;
    setSending(true);
    setError(null);
    const mentionedIds = mentionedParticipantIds(body, participants).filter((id) => id !== currentParticipant.id);
    const recipients = directRecipientId
      ? [directRecipientId]
      : mentionedIds.length > 0
        ? mentionedIds
        : "mission_broadcast";
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/conversation?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          senderParticipantId: currentParticipant.id,
          recipientParticipantIds: recipients,
          messageType,
          body,
          replyToMessageId: selectedThreadId,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(payload, "Could not send the message."));
      setReplyBody("");
      setIsTyping(false);
      setSelectedThreadId(null);
      window.dispatchEvent(new CustomEvent("participant.typing", { detail: { missionId, participantId: null } }));
      await Promise.all([refreshConversation(), refreshDeliveries()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid min-h-[520px] gap-0 lg:grid-cols-[180px_minmax(0,1fr)_220px]">
      <aside className="border-b border-[color:var(--ol-border-subtle)] p-4 lg:border-b-0 lg:border-r">
        <label className="block">
          <span className="sr-only">Search mission conversation</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages, agents, or message types"
            className="w-full rounded border border-[color:var(--ol-border-subtle)] bg-transparent px-2.5 py-2 text-xs text-[color:var(--ol-text-primary)] outline-none placeholder:text-[color:var(--ol-text-faint)] focus:border-[color:var(--ol-accent)]"
          />
        </label>
        <p className="mt-6 ol-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--ol-text-muted)]">Channels</p>
        <button type="button" className="mt-2 flex w-full items-center justify-between rounded bg-[color:var(--ol-surface-2)] px-2.5 py-2 text-left text-xs text-[color:var(--ol-text-primary)]">
          <span># mission</span>
          <span className="ol-mono text-[10px] text-[color:var(--ol-text-faint)]">{conversation?.messages.length ?? 0}</span>
        </button>
        <p className="mt-6 ol-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--ol-text-muted)]">Record</p>
        <div className="mt-2 space-y-2 text-xs text-[color:var(--ol-text-muted)]">
          <p>{activeDeliveryCount} delivery{activeDeliveryCount === 1 ? "" : "ies"} awaiting acknowledgement</p>
          <p>{unreadNotifications} unread notification{unreadNotifications === 1 ? "" : "s"}</p>
        </div>
      </aside>

      <main className="min-w-0 border-b border-[color:var(--ol-border-subtle)] lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-3 border-b border-[color:var(--ol-border-subtle)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[color:var(--ol-text-primary)]"># mission</h3>
            <p className="mt-0.5 text-[11px] text-[color:var(--ol-text-muted)]">Durable team conversation · {mission.state}</p>
          </div>
          {isTyping && <span className="text-[11px] text-[color:var(--ol-text-muted)]">Drafting…</span>}
        </div>
        <div className="max-h-[390px] min-h-[260px] overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="py-8 text-center text-xs text-[color:var(--ol-text-muted)]">Loading the mission record…</p>
          ) : threads.length === 0 ? (
            <p className="py-8 text-center text-xs text-[color:var(--ol-text-muted)]">No messages match this view.</p>
          ) : (
            <div className="space-y-4">
              {threads.map((thread) => (
                <article key={thread.root.id} className="rounded-md border border-[color:var(--ol-border-subtle)] p-3">
                  <MessageRow message={thread.root} participantById={participantById} />
                  {thread.replies.length > 0 && (
                    <div className="mt-3 space-y-2 border-l border-[color:var(--ol-border-subtle)] pl-3">
                      {thread.replies.map((reply) => <MessageRow key={reply.id} message={reply} participantById={participantById} compact />)}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedThreadId(thread.root.id)}
                    className="mt-3 text-[11px] font-medium text-[color:var(--ol-accent-text)] hover:underline"
                  >
                    Reply in thread{thread.replies.length > 0 ? ` · ${thread.replies.length}` : ""}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-[color:var(--ol-border-subtle)] p-4">
          {selectedThread && <p className="mb-2 text-[11px] text-[color:var(--ol-text-muted)]">Replying to {shortId(selectedThread.root.id)}</p>}
          <div className="flex flex-wrap gap-2">
            <select value={messageType} onChange={(event) => setMessageType(event.target.value as MessageType)} className="rounded border border-[color:var(--ol-border-subtle)] bg-transparent px-2 py-1.5 text-[11px] text-[color:var(--ol-text-secondary)]">
              {MESSAGE_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
            </select>
            <select value={directRecipientId} onChange={(event) => setDirectRecipientId(event.target.value)} className="rounded border border-[color:var(--ol-border-subtle)] bg-transparent px-2 py-1.5 text-[11px] text-[color:var(--ol-text-secondary)]">
              <option value="">Mission channel</option>
              {participants.filter((participant) => participant.id !== currentParticipant?.id).map((participant) => <option key={participant.id} value={participant.id}>Message {participant.displayName}</option>)}
            </select>
          </div>
          <textarea
            value={replyBody}
            onChange={(event) => handleComposerChange(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void sendMessage(); } }}
            placeholder={selectedThread ? "Reply to this thread…" : "Message the mission team…"}
            rows={3}
            className="mt-2 w-full resize-y rounded border border-[color:var(--ol-border-subtle)] bg-transparent px-3 py-2 text-sm text-[color:var(--ol-text-primary)] outline-none placeholder:text-[color:var(--ol-text-faint)] focus:border-[color:var(--ol-accent)]"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-[color:var(--ol-text-muted)]">Use @agent-name to target a teammate.</p>
            <button type="button" disabled={!replyBody.trim() || sending || !currentParticipant} onClick={() => void sendMessage()} className="rounded bg-[color:var(--ol-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          {error && <p role="alert" className="mt-2 text-xs text-[color:var(--ol-danger)]">{error}</p>}
        </div>
      </main>

      <aside className="p-4">
        <p className="ol-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--ol-text-muted)]">Agent roster</p>
        <div className="mt-3 space-y-2">
          {participants.length === 0 ? <p className="text-xs text-[color:var(--ol-text-muted)]">No participants registered.</p> : participants.map((participant) => (
            <div key={participant.id} className="flex items-start justify-between gap-2 rounded border border-[color:var(--ol-border-subtle)] px-2.5 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-[color:var(--ol-text-primary)]">{participant.displayName}</p>
                <p className="mt-0.5 truncate text-[10px] text-[color:var(--ol-text-muted)]">@{mentionHandle(participant.displayName)} · {participant.kind}</p>
              </div>
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${participant.status === "active" ? "bg-[color:var(--ol-ok)]" : "bg-[color:var(--ol-text-faint)]"}`} aria-label={participant.status} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function MessageRow({
  message,
  participantById,
  compact = false,
}: {
  message: MissionConversationDto["messages"][number];
  participantById: Map<string, MissionConversationDto["participants"][number]>;
  compact?: boolean;
}) {
  const sender = participantById.get(message.senderParticipantId);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs font-semibold text-[color:var(--ol-text-primary)]">{sender?.displayName ?? "Unknown participant"}</span>
        <span className="ol-mono text-[10px] text-[color:var(--ol-text-faint)]">{formatTime(message.createdAt)}</span>
        <span className="rounded border border-[color:var(--ol-border-subtle)] px-1.5 py-0.5 text-[10px] text-[color:var(--ol-text-muted)]">{message.type.replaceAll("_", " ")}</span>
      </div>
      <p className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[color:var(--ol-text-secondary)] ${compact ? "text-[13px]" : ""}`}>{message.body}</p>
      {message.evidenceRefs.length > 0 && <p className="mt-1 text-[10px] text-[color:var(--ol-text-muted)]">{message.evidenceRefs.length} evidence reference{message.evidenceRefs.length === 1 ? "" : "s"}</p>}
    </div>
  );
}
