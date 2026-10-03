"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/browser";
import { ensureGuestSession } from "@/lib/rooms/ensure-guest-session";
import { projectRoomArtifacts } from "@/lib/rooms/room-artifacts";
import styles from "../room-url.module.css";

type RoomView = { room: { id: string; name: string; status: string }; membership: { status: string } };
type PendingMember = { memberId: string; userId: string; requestedAt: string };
type RoomEvent = {
  id: string;
  sequence: number | string;
  room_id: string;
  actor_user_id: string | null;
  actor_seat_id: string | null;
  kind: string;
  causal_event_ids: string[];
  payload: Record<string, unknown>;
  created_at: string;
};
type RoomMember = {
  actorId: string;
  displayName: string;
  role: string;
  isYou: boolean;
  agents: Array<{ actorId: string; label: string; provider: string }>;
};
type RoomLease = {
  room_id: string;
  resource_key: string;
  holder_member_id: string;
  holder_seat_id: string | null;
  expires_at: string;
  version: number;
  preempted_member_id: string | null;
  preempted_seat_id: string | null;
  preempted_expires_at: string | null;
};
type RoomTask = { id: string; title: string; goal: string; doneCriteria: string[]; status: string; assigneeActorId: string | null; eventId: string; sequence: number };
type RoomHandoff = {
  id: string;
  taskId: string;
  recipientActorId: string;
  senderActorId: string;
  actorId: string;
  status: string;
  context: string;
  doneCriteria: string[];
  response?: string;
  eventId: string;
  sequence: number;
};
type PresenceEntry = { participantId?: string; displayName?: string; activity?: string };

function subscribeToLocationOrigin() {
  return () => {};
}

function getLocationOrigin() {
  return window.location.origin;
}

function getServerLocationOrigin() {
  return "";
}

function mergeRoomEvents(current: RoomEvent[], incoming: RoomEvent[]): RoomEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    if (!event || typeof event.id !== "string" || !Number.isFinite(Number(event.sequence))) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(-500);
}

function projectRoomTasks(events: RoomEvent[]): RoomTask[] {
  const tasks = new Map<string, RoomTask>();
  for (const event of events) {
    if (event.kind !== "task" || !event.payload || typeof event.payload !== "object") continue;
    const payload = event.payload;
    const id = typeof payload.taskId === "string" ? payload.taskId : "";
    if (!id) continue;
    const previous = tasks.get(id);
    const type = typeof payload.type === "string" ? payload.type : "updated";
    const status = typeof payload.status === "string" ? payload.status
      : type === "completed" ? "done" : type === "cancelled" ? "cancelled" : type === "blocked" ? "blocked" : previous?.status ?? "open";
    tasks.set(id, {
      id,
      title: typeof payload.title === "string" ? payload.title : previous?.title ?? "Untitled room task",
      goal: typeof payload.goal === "string" ? payload.goal : previous?.goal ?? "",
      doneCriteria: Array.isArray(payload.doneCriteria) ? payload.doneCriteria.filter((item): item is string => typeof item === "string") : previous?.doneCriteria ?? [],
      status,
      assigneeActorId: typeof payload.assigneeActorId === "string" ? payload.assigneeActorId : previous?.assigneeActorId ?? null,
      eventId: event.id,
      sequence: Number(event.sequence),
    });
  }
  return [...tasks.values()].sort((a, b) => a.sequence - b.sequence);
}

function projectRoomHandoffs(events: RoomEvent[]): RoomHandoff[] {
  const handoffs = new Map<string, RoomHandoff>();
  for (const event of events) {
    if (event.kind !== "handoff") continue;
    const payload = event.payload ?? {};
    const id = typeof payload.handoffId === "string" ? payload.handoffId : "";
    const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
    if (!id || !taskId) continue;
    const previous = handoffs.get(id);
    handoffs.set(id, {
      id,
      taskId,
      recipientActorId: typeof payload.recipientActorId === "string" ? payload.recipientActorId : previous?.recipientActorId ?? "",
      senderActorId: typeof payload.senderActorId === "string" ? payload.senderActorId : previous?.senderActorId ?? "",
      actorId: typeof payload.actorId === "string" ? payload.actorId : previous?.actorId ?? "",
      status: typeof payload.type === "string" ? payload.type : previous?.status ?? "unknown",
      context: typeof payload.context === "string" ? payload.context : previous?.context ?? "",
      doneCriteria: Array.isArray(payload.doneCriteria) ? payload.doneCriteria.filter((item): item is string => typeof item === "string") : previous?.doneCriteria ?? [],
      ...(typeof payload.response === "string" ? { response: payload.response } : previous?.response ? { response: previous.response } : {}),
      eventId: event.id,
      sequence: Number(event.sequence),
    });
  }
  return [...handoffs.values()].sort((a, b) => a.sequence - b.sequence);
}

function leaseActorId(lease: RoomLease): string {
  return lease.holder_seat_id ? `seat:${lease.holder_seat_id}` : `member:${lease.holder_member_id}`;
}

function leaseIsActive(lease: RoomLease | undefined): lease is RoomLease {
  return Boolean(lease && Date.parse(lease.expires_at) > Date.now());
}

function actorLabel(actorId: string, members: RoomMember[]): string {
  const member = members.find((candidate) => candidate.actorId === actorId);
  if (member) return member.displayName;
  for (const candidate of members) {
    const agent = candidate.agents.find((entry) => entry.actorId === actorId);
    if (agent) return `${agent.label} (${candidate.displayName})`;
  }
  return actorId.startsWith("seat:") ? "Room agent" : "Room member";
}

/**
 * A guest opens this link without creating a visible account: a silent anonymous
 * session is minted, a join is requested, and this page polls until the host admits
 * them. The room's creator sees the same page plus requests they can admit. The
 * flow requires "Allow anonymous sign-ins" in Supabase; see ensure-guest-session.ts.
 */
export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const [view, setView] = useState<RoomView | null>(null);
  const [pending, setPending] = useState<PendingMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const origin = useSyncExternalStore(subscribeToLocationOrigin, getLocationOrigin, getServerLocationOrigin);
  const shareUrl = origin ? new URL(`/rooms/${encodeURIComponent(roomId)}`, origin).toString() : "";
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [leases, setLeases] = useState<RoomLease[]>([]);
  const [onlineMembers, setOnlineMembers] = useState<PresenceEntry[]>([]);
  const [realtimeStatus, setRealtimeStatus] = useState("Connecting");
  const [eventError, setEventError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskCriteria, setTaskCriteria] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactContent, setArtifactContent] = useState("");
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(null);
  const [artifactBaseEventId, setArtifactBaseEventId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [coordinationBusy, setCoordinationBusy] = useState<string | null>(null);
  const [selectedSeatId, setSelectedSeatId] = useState("");
  const [handoffRecipients, setHandoffRecipients] = useState<Record<string, string>>({});
  const [handoffContexts, setHandoffContexts] = useState<Record<string, string>>({});
  const [handoffResponses, setHandoffResponses] = useState<Record<string, string>>({});
  const clientRef = useRef<ReturnType<typeof createClient>>(null);
  const userIdRef = useRef<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const tasks = useMemo(() => projectRoomTasks(events), [events]);
  const handoffs = useMemo(() => projectRoomHandoffs(events), [events]);
  const artifacts = useMemo(() => projectRoomArtifacts(events), [events]);
  const currentMember = members.find((member) => member.isYou);
  const currentActorId = selectedSeatId ? `seat:${selectedSeatId}` : currentMember?.actorId ?? "";
  const isRoomOwner = currentMember?.role === "owner";
  const agentCount = members.reduce((count, member) => count + member.agents.length, 0);

  const loadRoomEvents = useCallback(async () => {
    const response = await fetch(`/api/rooms/${roomId}/events?limit=100`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({})) as { events?: RoomEvent[] };
    if (Array.isArray(data.events)) setEvents((current) => mergeRoomEvents(current, data.events!));
  }, [roomId]);

  const loadCoordination = useCallback(async () => {
    const [memberResponse, leaseResponse] = await Promise.all([
      fetch(`/api/rooms/${roomId}/members`, { cache: "no-store" }),
      fetch(`/api/rooms/${roomId}/leases`, { cache: "no-store" }),
    ]);
    if (memberResponse.ok) {
      const data = await memberResponse.json().catch(() => ({})) as { members?: RoomMember[] };
      if (Array.isArray(data.members)) setMembers(data.members);
    }
    if (leaseResponse.ok) {
      const data = await leaseResponse.json().catch(() => ({})) as { leases?: RoomLease[] };
      if (Array.isArray(data.leases)) setLeases(data.leases);
    }
  }, [roomId]);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/rooms/${roomId}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({})) as RoomView & { error?: string };
    if (!response.ok) { setError(data.error ?? "Room not found."); return; }
    setError(null);
    setView(data);
    if (data.membership.status !== "requested" && data.membership.status !== "invited") {
      const pendingResponse = await fetch(`/api/rooms/${roomId}/pending`, { cache: "no-store" });
      if (pendingResponse.ok) {
        const pendingData = await pendingResponse.json() as { pending: PendingMember[] };
        setPending(pendingData.pending);
      } else {
        setPending(null);
      }
    } else {
      setPending(null);
    }
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const supabase = createClient();
      if (!supabase) { setError("Supabase is not configured."); return; }
      const guest = await ensureGuestSession(supabase);
      if (!guest.ok) {
        // Never show the provider's wording. Guest access depends on a project setting, so say what the person can do instead.
        setError(/anonymous/i.test(guest.error)
          ? `Guest access is not available yet. Sign in at /auth?next=/rooms/${roomId} to ask to join this room.`
          : "Could not join this room right now. Please try again.");
        return;
      }
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) { setError("Your room session could not be verified."); return; }
      clientRef.current = supabase;
      userIdRef.current = userData.user.id;
      setCurrentUserId(userData.user.id);
      // First contact requests a join (idempotent -- a returning active member stays active).
      await fetch(`/api/rooms/${roomId}/join`, { method: "POST" });
      if (cancelled) return;
      await refresh();
      poll = setInterval(() => { void refresh(); }, 4000);
    })();
    return () => { cancelled = true; if (poll) clearInterval(poll); };
  }, [roomId, refresh]);

  useEffect(() => {
    if (view?.membership.status !== "active") return;
    const supabase = clientRef.current;
    const userId = userIdRef.current;
    if (!supabase || !userId) return;
    let disposed = false;

    const loadCoordinationIfActive = async () => {
      const [memberResponse, leaseResponse] = await Promise.all([
        fetch(`/api/rooms/${roomId}/members`, { cache: "no-store" }),
        fetch(`/api/rooms/${roomId}/leases`, { cache: "no-store" }),
      ]);
      if (disposed) return;
      if (memberResponse.ok) {
        const data = await memberResponse.json().catch(() => ({})) as { members?: RoomMember[] };
        if (Array.isArray(data.members)) setMembers(data.members);
      }
      if (leaseResponse.ok) {
        const data = await leaseResponse.json().catch(() => ({})) as { leases?: RoomLease[] };
        if (Array.isArray(data.leases)) setLeases(data.leases);
      }
    };

    const eventChannel = supabase.channel(`m9r-room-events:${roomId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "m9r_room_events", filter: `room_id=eq.${roomId}` }, (change) => {
        const event = change.new as RoomEvent;
        if (!disposed && event?.room_id === roomId) setEvents((current) => mergeRoomEvents(current, [event]));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "m9r_room_leases", filter: `room_id=eq.${roomId}` }, () => {
        if (!disposed) void loadCoordinationIfActive();
      })
      .subscribe((status) => {
        if (disposed) return;
        setRealtimeStatus(status === "SUBSCRIBED" ? "Live" : status === "CHANNEL_ERROR" ? "Reconnecting" : status);
        if (status === "SUBSCRIBED") {
          void loadRoomEvents();
          void loadCoordinationIfActive();
        }
      });
    const coordinationPoll = setInterval(() => { void loadCoordinationIfActive(); }, 5_000);

    const presenceChannel = supabase.channel(`m9r-room-presence:${roomId}`, {
      config: { private: true, presence: { key: userId } },
    })
      .on("presence", { event: "sync" }, () => {
        const state = presenceChannel.presenceState() as Record<string, PresenceEntry[]>;
        const participants = Object.values(state).flat().filter((entry) => entry && typeof entry.participantId === "string");
        const unique = new Map(participants.map((entry) => [entry.participantId!, entry]));
        if (!disposed) setOnlineMembers([...unique.values()]);
      })
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          setRealtimeStatus("Live");
          void presenceChannel.track({
            participantId: userId,
            displayName: `Member ${userId.slice(0, 6)}`,
            activity: "viewing room",
          });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeStatus("Reconnecting");
        }
      });

    return () => {
      disposed = true;
      void presenceChannel.untrack();
      clearInterval(coordinationPoll);
      void supabase.removeChannel(presenceChannel);
      void supabase.removeChannel(eventChannel);
    };
  }, [roomId, view?.membership.status, loadRoomEvents]);

  async function appendEvent(kind: string, payload: Record<string, unknown>, causalEventIds: string[] = [], actorSeatId: string | null = selectedSeatId || null) {
    setSending(true);
    setEventError(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientEventId: crypto.randomUUID(), kind, payload, causalEventIds, actorSeatId }),
      });
      const data = await response.json().catch(() => ({})) as { event?: RoomEvent; error?: string };
      if (!response.ok || !data.event) {
        setEventError(data.error ?? "The room event was not saved.");
        return false;
      }
      setEvents((current) => mergeRoomEvents(current, [data.event!]));
      return true;
    } catch {
      setEventError("The room could not be reached. Your message was not saved.");
      return false;
    } finally {
      setSending(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || text.length > 4_000 || sending) return;
    if (await appendEvent("post", { text })) setMessage("");
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = taskTitle.trim();
    const goal = taskGoal.trim();
    const doneCriteria = taskCriteria.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!title || !goal || sending) return;
    if (doneCriteria.length < 1 || doneCriteria.length > 16 || doneCriteria.some((item) => item.length > 500)) {
      setEventError("Add between 1 and 16 completion criteria, each no longer than 500 characters.");
      return;
    }
    if (await appendEvent("task", { type: "created", taskId: crypto.randomUUID(), title, goal, doneCriteria, status: "open" })) {
      setTaskTitle("");
      setTaskGoal("");
      setTaskCriteria("");
    }
  }

  async function saveArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = artifactTitle.trim();
    if (!title || sending) return;
    if (new TextEncoder().encode(artifactContent).byteLength > 8_000) {
      setEventError("Shared artifact content must be at most 8 KB when UTF-8 encoded.");
      return;
    }
    if (editingArtifactId && !artifactBaseEventId) {
      setEventError("The artifact version could not be verified. Cancel and reopen the latest version before editing.");
      return;
    }
    const artifactId = editingArtifactId ?? crypto.randomUUID();
    const payload = {
      type: editingArtifactId ? "updated" : "created",
      artifactId,
      title,
      content: artifactContent,
      ...(editingArtifactId ? { baseEventId: artifactBaseEventId } : {}),
    };
    if (await appendEvent("artifact", payload, artifactBaseEventId ? [artifactBaseEventId] : [])) {
      setArtifactTitle("");
      setArtifactContent("");
      setEditingArtifactId(null);
      setArtifactBaseEventId(null);
    }
  }

  function editArtifact(artifact: { id: string; title: string; content: string; eventId: string }) {
    setEditingArtifactId(artifact.id);
    setArtifactBaseEventId(artifact.eventId);
    setArtifactTitle(artifact.title);
    setArtifactContent(artifact.content);
    setEventError(null);
  }

  function cancelArtifactEdit() {
    setEditingArtifactId(null);
    setArtifactBaseEventId(null);
    setArtifactTitle("");
    setArtifactContent("");
  }

  async function updateTask(task: RoomTask, type: "completed" | "blocked") {
    if (sending) return;
    await appendEvent("task", { type, taskId: task.id, status: type === "completed" ? "done" : "blocked" }, [task.eventId]);
  }

  async function changeLease(task: RoomTask, action: "acquire" | "release", preempt = false) {
    if (coordinationBusy) return;
    setCoordinationBusy(task.id);
    setEventError(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/leases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          clientEventId: crypto.randomUUID(),
          resourceKey: `task:${task.id}`,
          actorSeatId: selectedSeatId || null,
          ttlMs: action === "acquire" ? 30_000 : undefined,
          preempt,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; reason?: string };
      if (!response.ok) setEventError(data.error ?? (data.reason === "lease_held" ? "Another participant currently holds this task." : "The task lease was not changed."));
      await Promise.all([loadCoordination(), loadRoomEvents()]);
    } catch {
      setEventError("The room could not be reached. The task lease state may have changed; refresh before acting.");
    } finally {
      setCoordinationBusy(null);
    }
  }

  async function changeHandoff(
    action: "propose" | "accept" | "decline" | "counter" | "cancel" | "complete",
    task: RoomTask,
    handoff?: RoomHandoff,
  ) {
    if (coordinationBusy) return;
    const handoffId = handoff?.id ?? crypto.randomUUID();
    const recipientActorId = handoff?.recipientActorId ?? handoffRecipients[task.id] ?? "";
    const context = action === "propose" ? (handoffContexts[task.id] ?? task.goal).trim() : undefined;
    const responseText = action === "counter" ? (handoffResponses[handoffId] ?? "").trim() : undefined;
    if (!recipientActorId) { setEventError("Choose an active room member or agent for the handoff."); return; }
    if (action === "propose" && !context) { setEventError("Add the context the receiving participant needs."); return; }
    if (action === "counter" && !responseText) { setEventError("Write the counteroffer before sending it."); return; }

    setCoordinationBusy(handoffId);
    setEventError(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/handoffs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          clientEventId: crypto.randomUUID(),
          handoffId,
          taskId: task.id,
          actorSeatId: selectedSeatId || null,
          recipientActorId,
          ...(action === "propose" ? { context, doneCriteria: task.doneCriteria } : {}),
          ...(action === "counter" ? { response: responseText } : {}),
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setEventError(data.error ?? "The handoff was not changed.");
      else if (action === "propose") setHandoffContexts((current) => ({ ...current, [task.id]: "" }));
      await Promise.all([loadRoomEvents(), loadCoordination()]);
    } catch {
      setEventError("The room could not be reached. Refresh before retrying the handoff.");
    } finally {
      setCoordinationBusy(null);
    }
  }

  async function admit(memberId: string) {
    const response = await fetch(`/api/rooms/${roomId}/members/${memberId}/admit`, { method: "POST" });
    if (response.ok) void refresh();
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(shareUrl);
      setCopyError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setCopyError("Clipboard access was blocked. Select the room URL above to copy it manually.");
    }
  }

  if (error) return <div className={styles.page}><main className={styles.roomShell}><p className={styles.inlineError} role="alert">{error}</p></main></div>;
  if (!view) return <div className={styles.page}><main className={styles.roomShell}><p className={styles.loadingMessage} role="status">Loading room…</p></main></div>;

  const status = view.membership.status;
  const roomIsLive = view.room.status === "active";
  const pageTitle = status === "active" ? `“${view.room.name}” is ready.` : view.room.name;
  const pageDescription = status === "requested"
    ? "Your request is with the host. This room will open here if you are admitted."
    : status === "denied"
      ? "The host denied this request. You can still copy the room link to keep it handy."
      : "Share this link with people and agents you want to coordinate with. They can ask to join; the room host reviews every request.";

  return (
    <div className={styles.page}>
      <main className={styles.roomShell}>
        <header className={styles.shareHero}>
          <p className={styles.shareEyebrow}>
            {status === "active" && roomIsLive && <span className={styles.liveDot} aria-hidden="true" />}
            {status === "active" ? roomIsLive ? "Room is live" : "Room link ready" : status === "requested" ? "Request sent" : status === "denied" ? "Request denied" : "Room link"}
          </p>
          <h1 className={styles.shareTitle}>{pageTitle}</h1>
          <p className={styles.shareLede}>{pageDescription}</p>

          <div className={styles.shareUrlRow}>
            <input
              className={styles.shareUrlInput}
              aria-label="Shareable room URL"
              readOnly
              value={shareUrl}
              placeholder="Preparing room link…"
            />
            <button className={`${styles.primaryButton} ${styles.copyButton}`} onClick={() => void copyLink()} disabled={!shareUrl}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className={`${styles.copyFeedback} ${copyError ? styles.copyFeedbackError : ""}`} role="status" aria-live="polite">
            {copyError ?? (copied ? "Room link copied." : "")}
          </p>

          <dl className={styles.roomSummary} aria-label="Room summary">
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>MEMBERS</dt>
              <dd className={styles.summaryValue}>{members.length ? members.length : "—"}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>AGENTS</dt>
              <dd className={styles.summaryValue}>{members.length ? agentCount : "—"}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>REQUESTS WAITING</dt>
              <dd className={styles.summaryValue}>{pending === null ? "—" : pending.length}</dd>
            </div>
          </dl>

          {status === "active" && <a className={styles.workspaceLink} href="#room-workspace">Continue to the room workspace ↓</a>}
        </header>

      {status === "requested" && <p className={styles.statusBanner} role="status">Waiting for the host to let you in…</p>}
      {status === "denied" && <p className={`${styles.statusBanner} ${styles.statusBannerError}`} role="status">The host denied this request.</p>}
      {status === "active" && (
        <section id="room-workspace" className={styles.collaboration} aria-label="Shared room">
          <div className={styles.panel}>
            <h2 style={{ marginTop: 0 }}>Room presence <span aria-live="polite" style={{ fontSize: 13, fontWeight: 400 }}>· {realtimeStatus}</span></h2>
            {eventError && <p className={styles.inlineError} role="alert">{eventError}</p>}
            {onlineMembers.length === 0 ? <p>No other members are currently here.</p> : (
              <ul aria-label="Members currently in the room">
                {onlineMembers.map((member) => <li key={member.participantId}>{member.displayName ?? "Room member"} — {member.activity ?? "present"}</li>)}
              </ul>
            )}
            <h3>Admitted participants</h3>
            {members.length === 0 ? <p>Loading room members…</p> : (
              <ul aria-label="Admitted room participants">
                {members.map((member) => <li key={member.actorId}>{member.displayName} ({member.role}){member.agents.map((agent) => <span key={agent.actorId}> · {agent.label} / {agent.provider}</span>)}</li>)}
              </ul>
            )}
            {(currentMember?.agents.length ?? 0) > 0 && (
              <label htmlFor="room-acting-agent">Acting identity
                <select id="room-acting-agent" value={selectedSeatId} onChange={(event) => setSelectedSeatId(event.target.value)} style={{ display: "block", marginTop: 4 }}>
                  <option value="">You (room member)</option>
                  {currentMember?.agents.map((agent) => <option key={agent.actorId} value={agent.actorId.slice("seat:".length)}>{agent.label} ({agent.provider})</option>)}
                </select>
              </label>
            )}
            <p className={styles.muted}>Presence is live-only. Page data, browser cursors, and local credentials are not included.</p>
          </div>

          <div className={styles.panel}>
            <h2 style={{ marginTop: 0 }}>Shared artifacts</h2>
            <p className={styles.muted}>Room documents are durable snapshots. Edits are serialized and based on the exact version you opened; a competing edit is rejected instead of silently overwritten. Only include material intended for every admitted room member.</p>
            <form onSubmit={(event) => void saveArtifact(event)} style={{ display: "grid", gap: 8 }}>
              <label>Artifact title<input value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} maxLength={160} required style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
              <label>Shared content<textarea value={artifactContent} onChange={(event) => setArtifactContent(event.target.value)} maxLength={8000} rows={8} style={{ display: "block", width: "100%", marginTop: 4, fontFamily: "ui-monospace, monospace" }} /></label>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={sending || !artifactTitle.trim()} type="submit" style={{ justifySelf: "start", padding: "6px 12px" }}>{editingArtifactId ? "Save shared artifact" : "Create shared artifact"}</button>
                {editingArtifactId && <button disabled={sending} type="button" onClick={cancelArtifactEdit}>Cancel edit</button>}
              </div>
            </form>
            {artifacts.length === 0 ? <p>No shared artifacts yet.</p> : (
              <ul aria-label="Shared room artifacts" style={{ paddingLeft: 22 }}>
                {artifacts.map((artifact) => <li key={artifact.id} style={{ marginTop: 16 }}>
                  <strong>{artifact.title}</strong> <button type="button" disabled={sending} onClick={() => editArtifact(artifact)}>Edit latest version</button>
                  <pre className={styles.artifactBody}>{artifact.content || "(empty artifact)"}</pre>
                </li>)}
              </ul>
            )}
          </div>

          <div className={styles.panel}>
            <h2 style={{ marginTop: 0 }}>Shared goals</h2>
            <form onSubmit={(event) => void createTask(event)} style={{ display: "grid", gap: 8 }}>
              <label>Task title<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={160} required style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
              <label>Goal<textarea value={taskGoal} onChange={(event) => setTaskGoal(event.target.value)} maxLength={4000} required rows={3} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
              <label>What does done look like? (one criterion per line)<textarea value={taskCriteria} onChange={(event) => setTaskCriteria(event.target.value)} maxLength={4000} required rows={3} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
              <button disabled={sending} type="submit" style={{ justifySelf: "start", padding: "6px 12px" }}>Add shared goal</button>
            </form>
            {tasks.length === 0 ? <p>No shared goals yet.</p> : (
              <ul aria-label="Shared room goals" style={{ paddingLeft: 22 }}>
                {tasks.map((task) => (
                  (() => {
                    const taskLease = leases.find((lease) => lease.resource_key === `task:${task.id}`);
                    const activeLease = leaseIsActive(taskLease) ? taskLease : undefined;
                    const leaseOwner = activeLease ? leaseActorId(activeLease) : null;
                    const controlsTask = !leaseOwner || leaseOwner === currentActorId;
                    const mayTakeOver = isRoomOwner && !selectedSeatId && Boolean(leaseOwner && leaseOwner !== currentActorId);
                    const priorHandoff = handoffs.filter((entry) => entry.taskId === task.id).at(-1);
                    const awaitingHandoff = priorHandoff && ["proposed", "countered"].includes(priorHandoff.status) ? priorHandoff : null;
                    const nextResponder = awaitingHandoff
                      ? awaitingHandoff.status === "proposed" ? awaitingHandoff.recipientActorId
                        : awaitingHandoff.actorId === awaitingHandoff.recipientActorId ? awaitingHandoff.senderActorId : awaitingHandoff.recipientActorId
                      : null;
                    const canRespond = Boolean(awaitingHandoff && currentActorId === nextResponder);
                    const canCancel = Boolean(awaitingHandoff && (currentActorId === awaitingHandoff.senderActorId || (isRoomOwner && !selectedSeatId)));
                    const targets = members.flatMap((member) => [
                      { actorId: member.actorId, label: `${member.displayName} (member)` },
                      ...member.agents.map((agent) => ({ actorId: agent.actorId, label: `${agent.label} — ${member.displayName}` })),
                    ]).filter((target) => target.actorId !== currentActorId);
                    return <li key={task.id} style={{ marginTop: 12 }}>
                      <strong>{task.title}</strong> <span>({task.status})</span>
                      <p>{task.goal}</p>
                      <ul>{task.doneCriteria.map((criterion, index) => <li key={`${task.id}-${index}`}>{criterion}</li>)}</ul>
                      {task.assigneeActorId && <p>Assigned to {actorLabel(task.assigneeActorId, members)}</p>}
                      <p aria-live="polite">{activeLease
                        ? `Control held by ${actorLabel(leaseOwner!, members)} until ${new Date(activeLease.expires_at).toLocaleTimeString()}.`
                        : "No active task lease."}</p>
                      {task.status !== "done" && task.status !== "cancelled" && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                          {leaseOwner === currentActorId ? (
                            <button disabled={coordinationBusy !== null} onClick={() => void changeLease(task, "release")}>Release control</button>
                          ) : mayTakeOver ? (
                            <button disabled={coordinationBusy !== null} onClick={() => void changeLease(task, "acquire", true)}>Take over lease</button>
                          ) : !leaseOwner ? (
                            <button disabled={coordinationBusy !== null} onClick={() => void changeLease(task, "acquire")}>Take control</button>
                          ) : <button disabled>Held by another participant</button>}
                          <button disabled={sending || !controlsTask} onClick={() => void updateTask(task, "completed")}>Mark done</button>
                          <button disabled={sending || !controlsTask || task.status === "blocked"} onClick={() => void updateTask(task, "blocked")}>Mark blocked</button>
                        </div>
                      )}
                      {awaitingHandoff ? (
                        <div style={{ marginTop: 12, borderLeft: "3px solid #8c959f", paddingLeft: 12 }}>
                          <strong>Handoff {awaitingHandoff.status}</strong>
                          <p>From {actorLabel(awaitingHandoff.senderActorId, members)} to {actorLabel(awaitingHandoff.recipientActorId, members)}: {awaitingHandoff.context}</p>
                          {awaitingHandoff.response && <p>Latest response: {awaitingHandoff.response}</p>}
                          {awaitingHandoff.doneCriteria.length > 0 && <ul>{awaitingHandoff.doneCriteria.map((criterion, index) => <li key={`${awaitingHandoff.id}-${index}`}>{criterion}</li>)}</ul>}
                          {canRespond && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              <button disabled={coordinationBusy !== null} onClick={() => void changeHandoff("accept", task, awaitingHandoff)}>Accept handoff</button>
                              <button disabled={coordinationBusy !== null} onClick={() => void changeHandoff("decline", task, awaitingHandoff)}>Decline</button>
                              <label>Counteroffer
                                <input value={handoffResponses[awaitingHandoff.id] ?? ""} maxLength={2000} onChange={(event) => setHandoffResponses((current) => ({ ...current, [awaitingHandoff.id]: event.target.value }))} />
                              </label>
                              <button disabled={coordinationBusy !== null} onClick={() => void changeHandoff("counter", task, awaitingHandoff)}>Send counteroffer</button>
                            </div>
                          )}
                          {canCancel && <button disabled={coordinationBusy !== null} onClick={() => void changeHandoff("cancel", task, awaitingHandoff)}>Cancel handoff</button>}
                        </div>
                      ) : priorHandoff?.status === "accepted" && currentActorId === priorHandoff.recipientActorId ? (
                        <div style={{ marginTop: 12 }}><strong>Handoff accepted.</strong> <button disabled={coordinationBusy !== null} onClick={() => void changeHandoff("complete", task, priorHandoff)}>Complete handoff</button></div>
                      ) : priorHandoff ? <p>Latest handoff: {priorHandoff.status}</p> : null}
                      {!awaitingHandoff && task.status !== "done" && task.status !== "cancelled" && targets.length > 0 && controlsTask && (
                        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                          <label>Hand off to
                            <select value={handoffRecipients[task.id] ?? ""} onChange={(event) => setHandoffRecipients((current) => ({ ...current, [task.id]: event.target.value }))}>
                              <option value="">Choose an admitted participant</option>
                              {targets.map((target) => <option key={target.actorId} value={target.actorId}>{target.label}</option>)}
                            </select>
                          </label>
                          <label>Context for the receiver
                            <textarea value={handoffContexts[task.id] ?? task.goal} onChange={(event) => setHandoffContexts((current) => ({ ...current, [task.id]: event.target.value }))} maxLength={4000} rows={2} />
                          </label>
                          <button disabled={coordinationBusy !== null} onClick={() => void changeHandoff("propose", task)}>Propose handoff</button>
                        </div>
                      )}
                    </li>;
                  })()
                ))}
              </ul>
            )}
          </div>

          <div className={styles.panel}>
            <h2 style={{ marginTop: 0 }}>Activity</h2>
            <p className={styles.muted}>Messages and goals persist for admitted room members. Do not send passwords, tokens, private page contents, or local file contents.</p>
            <ol aria-live="polite" aria-relevant="additions" style={{ maxHeight: 360, overflow: "auto", paddingLeft: 24 }}>
              {events.filter((event) => ["post", "ask", "reply", "task", "handoff", "artifact"].includes(event.kind)).map((event) => {
                const actor = event.actor_seat_id ? `Agent ${event.actor_seat_id.slice(0, 6)}`
                  : event.actor_user_id === currentUserId ? "You" : `Member ${String(event.actor_user_id ?? "unknown").slice(0, 6)}`;
                const payload = event.payload ?? {};
                const eventText = typeof payload.text === "string" ? payload.text : null;
                const taskLabel = event.kind === "task" ? `${String(payload.type ?? "updated")} goal: ${String(payload.title ?? payload.taskId ?? "room task")}` : null;
                const handoffLabel = event.kind === "handoff" ? `${String(payload.type ?? "handoff")} handoff${typeof payload.context === "string" ? `: ${payload.context}` : ""}` : null;
                const artifactLabel = event.kind === "artifact" ? `${String(payload.type ?? "updated")} artifact: ${String(payload.title ?? payload.artifactId ?? "shared document")}` : null;
                return <li key={event.id} style={{ marginBottom: 10 }}><strong>{actor}</strong>{eventText ? `: ${eventText}` : taskLabel ? ` — ${taskLabel}` : handoffLabel ? ` — ${handoffLabel}` : artifactLabel ? ` — ${artifactLabel}` : ` — ${event.kind}`}<time className={styles.muted} style={{ display: "block" }} dateTime={event.created_at}>{new Date(event.created_at).toLocaleTimeString()}</time></li>;
              })}
              {events.length === 0 && <li>No shared activity yet.</li>}
            </ol>
            <form onSubmit={(event) => void sendMessage(event)} style={{ display: "grid", gap: 8 }}>
              <label htmlFor="room-message">Message the room</label>
              <textarea id="room-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} rows={3} required />
              <button disabled={sending || !message.trim()} type="submit" style={{ justifySelf: "start", padding: "6px 12px" }}>Send to room</button>
            </form>
          </div>
        </section>
      )}

      {pending !== null && (
        <div className={`${styles.panel} ${styles.pendingPanel}`}>
          <h2>Pending requests</h2>
          {pending.length === 0 ? (
            <p>Nobody is waiting.</p>
          ) : (
            <ul className={styles.pendingList}>
              {pending.map((m) => (
                <li key={m.memberId} style={{ marginBottom: 8 }}>
                  Guest {m.userId.slice(0, 8)} — requested {new Date(m.requestedAt).toLocaleTimeString()}{" "}
                  <button onClick={() => void admit(m.memberId)} style={{ padding: "2px 8px" }}>Admit</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </main>
    </div>
  );
}
