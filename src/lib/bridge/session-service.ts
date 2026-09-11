/**
 * Shared Live Sessions v2 -- see M9R_MASTER_BUILD_PLAN.md item 1 for the
 * full design this implements.
 *
 * A Session is a bounded, lifecycled unit of work (one task, possibly
 * spanning several turns/queued follow-ups), not a raw individual turn.
 * v1 listed raw turns from workspace_turn_timing_events and broke: a wrong
 * terminal-stage check (missing report.observed, which fires AFTER
 * turn.completed) left every completed turn permanently "active".
 *
 * This module derives Sessions from workspace_turn_timing_events at read
 * time (grouping consecutive turns for the same conversation+connection
 * into one session, splitting on a long gap) and upserts the *open*
 * (non-archived) ones into conversation_sessions so archive state has
 * somewhere durable to live. Archived sessions are never re-derived or
 * touched again by this sync -- once archived, only an explicit action
 * changes them.
 */
import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

function requireService() {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return supabase;
}

interface SessionDashboardUserContext {
  user: { id: string };
  workspaceId: string;
}

async function dashboardUserContext(): Promise<SessionDashboardUserContext> {
  const auth = await createClient();
  if (!auth) throw new Error("Authentication is unavailable.");
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Sign in to use workspace chat.");
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, { id: user.id, email: user.email, name: null });
  if (!workspaceId) throw new Error("No workspace is available for this account.");
  return { user: { id: user.id }, workspaceId };
}

// The full, correct terminal-stage set. report.observed and
// fallback_report.posted both fire AFTER turn.completed/failed/rejected --
// treating only the latter three as terminal (the v1 bug) leaves a healthy,
// finished turn looking permanently in-progress.
const TERMINAL_STAGES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.rejected",
  "report.observed",
  "fallback_report.posted",
  "ack.completed",
]);

// A workspace-wide lookback for deriving candidate sessions -- bounds how
// many timing rows a sync pass has to scan.
const DERIVE_LOOKBACK_MS = 6 * 60 * 60_000;
// How long a session must sit idle (waiting, no new turns) before the
// system proposes archiving it on the agent's behalf. This decides *when*
// to raise the question, never *whether* it gets archived -- an explicit
// human confirmation is still required either way, so this is not the
// "silent timer" that v1's design was corrected away from.
const IDLE_BEFORE_ARCHIVE_PROPOSAL_MS = 15 * 60_000;

export type SessionStatus = "active" | "waiting" | "archived";

export interface DashboardSession {
  id: string;
  conversationId: string;
  conversationTopic: string;
  connectionId: string | null;
  ownerLabel: string;
  title: string;
  status: SessionStatus;
  anchorMessageId: string | null;
  latestMessageId: string | null;
  startedAtMs: number;
  lastActivityAtMs: number;
  archiveProposed: boolean;
  archivedAtMs: number | null;
}

/**
 * Sync open sessions from recent turn activity, then return every
 * non-archived session for the workspace (active + waiting).
 *
 * The first version of this sync recomputed session grouping from scratch
 * on every poll (a rolling window fed through a group-by-gap pass), then
 * tried to match the result back to an existing row by its anchor message.
 * That was unstable: which message ends up "the anchor" of a group shifts
 * depending on exactly what's in the window at that moment, so the same
 * real task got a different anchor on different polls, failed to match,
 * and a fresh row got inserted every few seconds -- the same "zombie
 * entries" failure as v1, just from an unstable read instead of a wrong
 * terminal-stage check.
 *
 * Fixed by making message-to-session assignment a one-time, durable claim
 * instead of a recomputed grouping: every message_id that has ever been
 * added to any session (open or archived) is tracked in that session's
 * `message_ids`, and this sync only ever looks at turns whose message_id
 * has NOT yet been claimed by any session. A newly-unclaimed turn either
 * extends the conversation+connection's current open session (if one
 * exists and the gap since its last activity is short enough) or starts a
 * new one. Once a message_id is claimed, no later poll can re-derive it
 * into a different session -- there is nothing left to recompute.
 */
export async function syncAndListOpenSessions(): Promise<DashboardSession[]> {
  const context = await dashboardUserContext();
  const db = requireService();

  const { data: rows, error } = await db
    .from("workspace_turn_timing_events")
    .select("message_id, conversation_id, stage, at_ms")
    .eq("workspace_id", context.workspaceId)
    .gte("occurred_at", new Date(Date.now() - DERIVE_LOOKBACK_MS).toISOString())
    .not("message_id", "is", null)
    .order("at_ms", { ascending: false })
    .limit(4000);
  if (error) throw new Error("Could not read turn activity for session derivation.");

  const latestByMessage = new Map<string, { conversationId: string; stage: string; atMs: number }>();
  for (const row of rows ?? []) {
    const messageId = row.message_id as string;
    if (latestByMessage.has(messageId)) continue; // newest-first: first hit per message is its latest event
    latestByMessage.set(messageId, {
      conversationId: row.conversation_id as string,
      stage: row.stage as string,
      atMs: Number(row.at_ms),
    });
  }
  if (latestByMessage.size === 0) return listOpenSessionsFromTable(context.workspaceId, db);

  const conversationIds = [...new Set([...latestByMessage.values()].map((t) => t.conversationId))];
  const [{ data: participants }, { data: existingSessions }] = await Promise.all([
    db.from("conversation_participants").select("conversation_id, connection_id").in("conversation_id", conversationIds),
    // Every session (open AND archived) for these conversations, to know
    // which message_ids are already claimed and which conversations have a
    // currently-open session to extend.
    db.from("conversation_sessions").select("id, conversation_id, connection_id, status, message_ids, last_activity_at, archive_proposed_at")
      .eq("workspace_id", context.workspaceId).in("conversation_id", conversationIds),
  ]);
  // Every connected agent in a conversation (not just the first row) --
  // a shared channel like #general can have more than one agent connected
  // at once (confirmed live: both Codex and Claude Code), so "the first
  // participant row" is not a safe stand-in for "who actually ran this
  // turn." That was wrong: a session anchored on an "@claude-code ..."
  // message was showing "Codex" as its owner, because Codex happened to be
  // listed first. Real ownership is resolved per-turn below, from the
  // agent that actually replied.
  const participantsByConversation = new Map<string, string[]>();
  for (const p of participants ?? []) {
    const list = participantsByConversation.get(p.conversation_id as string) ?? [];
    list.push(p.connection_id as string);
    participantsByConversation.set(p.conversation_id as string, list);
  }

  // Keyed by conversation+connection, never by conversation alone and never
  // split by a time gap -- confirmed with the human: exactly one open
  // session per (channel, agent) at a time, no matter how many separate
  // asks land in it or how much time passes between them. It only ends via
  // an explicit archive; a new session for that channel+agent starts only
  // once the current one is archived. (A prior version split on a 20-minute
  // gap, which meant every prompt sent more than 20 minutes after the last
  // one silently started a new, never-cleaned-up session -- confirmed live
  // to flood the panel with one row per burst of activity across a day of
  // testing. That gap logic is gone entirely, not just widened.)
  const claimedMessageIds = new Set<string>();
  const openSessionByKey = new Map<string, { id: string; connectionId: string | null; messageIds: string[]; archiveProposed: boolean }>();
  const keyFor = (conversationId: string, connectionId: string | null) => `${conversationId}::${connectionId ?? "unresolved"}`;
  for (const s of existingSessions ?? []) {
    for (const id of (s.message_ids as string[] | null) ?? []) claimedMessageIds.add(id);
    if (s.status !== "archived") {
      openSessionByKey.set(keyFor(s.conversation_id as string, s.connection_id as string | null), {
        id: s.id as string,
        connectionId: s.connection_id as string | null,
        messageIds: [...((s.message_ids as string[] | null) ?? [])],
        archiveProposed: !!s.archive_proposed_at,
      });
    }
  }

  // Oldest first, so a session's activity is applied in the order it
  // actually happened.
  const unclaimedTurns = [...latestByMessage.entries()]
    .filter(([messageId]) => !claimedMessageIds.has(messageId))
    .map(([messageId, v]) => ({ messageId, ...v }))
    .sort((a, b) => a.atMs - b.atMs);

  for (const turn of unclaimedTurns) {
    const isTerminal = TERMINAL_STAGES.has(turn.stage);
    const status: "active" | "waiting" = isTerminal ? "waiting" : "active";
    const connectionId = await resolveTurnConnectionId(db, turn.messageId, participantsByConversation.get(turn.conversationId) ?? []);
    // Ownership resolved (ambiguous multi-agent channel, reply not posted
    // yet) falls into a shared "unresolved" bucket for this conversation
    // rather than silently attaching to whichever agent's session happens
    // to already be open -- that would misattribute it, the exact bug just
    // fixed for the single-turn case.
    const open = openSessionByKey.get(keyFor(turn.conversationId, connectionId));

    if (open) {
      open.messageIds.push(turn.messageId);
      await db.from("conversation_sessions").update({
        status,
        latest_message_id: turn.messageId,
        message_ids: open.messageIds,
        last_activity_at: new Date(turn.atMs).toISOString(),
        // New activity means the work clearly isn't done -- clear any
        // pending archive proposal AND any earlier dismissal, so idleness
        // starting from this new activity gets judged fresh.
        archive_proposed_at: status === "active" ? null : undefined,
        archive_proposed_message_id: status === "active" ? null : undefined,
        archive_dismissed_at: status === "active" ? null : undefined,
      }).eq("id", open.id);
      if (status === "active") open.archiveProposed = false;
      claimedMessageIds.add(turn.messageId);
      continue;
    }

    const ownerUserId = connectionId ? await ownerUserIdForConnection(db, connectionId) : null;
    const title = await titleForSession(db, turn.messageId);
    const { data: inserted, error: insertError } = await db.from("conversation_sessions").insert({
      workspace_id: context.workspaceId,
      conversation_id: turn.conversationId,
      connection_id: connectionId,
      owner_user_id: ownerUserId,
      title,
      status,
      anchor_message_id: turn.messageId,
      latest_message_id: turn.messageId,
      message_ids: [turn.messageId],
      created_at: new Date(turn.atMs).toISOString(),
      last_activity_at: new Date(turn.atMs).toISOString(),
    }).select("id").single();
    claimedMessageIds.add(turn.messageId);

    if (insertError) {
      // 23505 = unique_violation on conversation_sessions_open_unique: a
      // concurrent sync (another poll tick) inserted the open session for
      // this channel+agent between this pass's read and this insert. That
      // is not a failure -- it means the session this turn belongs to now
      // exists under a different id than expected. Fetch it and extend it,
      // rather than dropping the turn or surfacing a spurious error.
      if (insertError.code === "23505") {
        let winnerQuery = db.from("conversation_sessions")
          .select("id, message_ids")
          .eq("workspace_id", context.workspaceId).eq("conversation_id", turn.conversationId)
          .neq("status", "archived");
        winnerQuery = connectionId ? winnerQuery.eq("connection_id", connectionId) : winnerQuery.is("connection_id", null);
        const { data: winner } = await winnerQuery.maybeSingle();
        if (winner) {
          const mergedIds = Array.from(new Set([...((winner.message_ids as string[] | null) ?? []), turn.messageId]));
          await db.from("conversation_sessions").update({
            status, latest_message_id: turn.messageId, message_ids: mergedIds, last_activity_at: new Date(turn.atMs).toISOString(),
          }).eq("id", winner.id);
          openSessionByKey.set(keyFor(turn.conversationId, connectionId), { id: winner.id as string, connectionId, messageIds: mergedIds, archiveProposed: false });
        }
      }
      continue;
    }
    if (inserted?.id) {
      openSessionByKey.set(keyFor(turn.conversationId, connectionId), { id: inserted.id as string, connectionId, messageIds: [turn.messageId], archiveProposed: false });
    }
  }

  await proposeArchiveForIdleSessions(context.workspaceId, db);

  return listOpenSessionsFromTable(context.workspaceId, db);
}

/**
 * Who actually ran this turn -- resolved from the agent's own reply
 * (conversation_messages.parent_message_id -> the triggering message,
 * sender_connection_id -> the connection that answered), never guessed
 * from channel membership. A shared channel can have more than one agent
 * connected at once (confirmed live: #general has both Codex and Claude
 * Code), so "whichever participant row came back first" is not a safe
 * stand-in -- that produced a session anchored on an "@claude-code ..."
 * message showing "Codex" as its owner, simply because Codex's
 * conversation_participants row happened to sort first.
 *
 * Falls back to the sole connected agent only when the channel has
 * exactly one (unambiguous even before any reply exists, e.g. while the
 * turn is still running) -- otherwise returns null rather than mislabel.
 */
async function resolveTurnConnectionId(
  db: ReturnType<typeof requireService>,
  triggeringMessageId: string,
  conversationConnectionIds: string[],
): Promise<string | null> {
  const { data: reply } = await db
    .from("conversation_messages")
    .select("sender_connection_id")
    .eq("parent_message_id", triggeringMessageId)
    .not("sender_connection_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (reply?.sender_connection_id) return reply.sender_connection_id as string;

  const distinct = [...new Set(conversationConnectionIds)];
  return distinct.length === 1 ? distinct[0] : null;
}

async function ownerUserIdForConnection(db: ReturnType<typeof requireService>, connectionId: string): Promise<string | null> {
  const { data } = await db.from("agent_connections").select("created_by").eq("id", connectionId).maybeSingle();
  return (data?.created_by as string | null) ?? null;
}

async function titleForSession(db: ReturnType<typeof requireService>, anchorMessageId: string): Promise<string> {
  const { data } = await db.from("conversation_messages").select("body").eq("id", anchorMessageId).maybeSingle();
  const body = (data?.body as string | null) ?? "";
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed) return "Untitled session";
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

async function listOpenSessionsFromTable(workspaceId: string, db: ReturnType<typeof requireService>): Promise<DashboardSession[]> {
  const { data: sessions, error } = await db
    .from("conversation_sessions")
    .select("id, conversation_id, connection_id, owner_user_id, title, status, anchor_message_id, latest_message_id, created_at, last_activity_at, archive_proposed_at")
    .eq("workspace_id", workspaceId)
    .neq("status", "archived")
    .order("last_activity_at", { ascending: false });
  if (error) throw new Error("Could not read live sessions.");
  return attachDisplayFields(workspaceId, db, sessions ?? []);
}

export async function listArchivedSessions(): Promise<DashboardSession[]> {
  const context = await dashboardUserContext();
  const db = requireService();
  const { data: sessions, error } = await db
    .from("conversation_sessions")
    .select("id, conversation_id, connection_id, owner_user_id, title, status, anchor_message_id, latest_message_id, created_at, last_activity_at, archive_proposed_at, archived_at")
    .eq("workspace_id", context.workspaceId)
    .eq("status", "archived")
    .order("archived_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Could not read archived sessions.");
  return attachDisplayFields(context.workspaceId, db, sessions ?? []);
}

async function attachDisplayFields(
  workspaceId: string,
  db: ReturnType<typeof requireService>,
  rows: Array<Record<string, unknown>>,
): Promise<DashboardSession[]> {
  if (rows.length === 0) return [];
  const conversationIds = [...new Set(rows.map((r) => r.conversation_id as string))];
  const connectionIds = [...new Set(rows.map((r) => r.connection_id as string | null).filter((v): v is string => !!v))];
  const [{ data: conversations }, { data: connections }] = await Promise.all([
    db.from("agent_conversations").select("id, topic").in("id", conversationIds),
    connectionIds.length ? db.from("agent_connections").select("id, agent_kind, created_by").in("id", connectionIds) : Promise.resolve({ data: [] as Array<{ id: string; agent_kind: string; created_by: string | null }> }),
  ]);
  const topicById = new Map((conversations ?? []).map((c) => [c.id as string, c.topic as string]));
  const connectionById = new Map((connections ?? []).map((c) => [c.id as string, c]));

  // Per-owner identity display rule: only disambiguate with an owner name
  // once a workspace has more than one connection of the same agent kind.
  // A single Claude connection just shows "Claude" -- no clutter.
  const kindCounts = new Map<string, number>();
  for (const c of connections ?? []) {
    const kind = c.agent_kind as string;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const ownerUserIds = [...new Set((connections ?? []).map((c) => c.created_by as string | null).filter((v): v is string => !!v))];
  const ownerLabelById = new Map<string, string>();
  if (ownerUserIds.length > 0) {
    const { data: owners } = await db.from("users").select("id, email, name").in("id", ownerUserIds);
    for (const o of owners ?? []) {
      const label = (o.name as string | null) || ((o.email as string | null)?.split("@")[0] ?? "Someone");
      ownerLabelById.set(o.id as string, label);
    }
  }

  return rows.map((row) => {
    const connection = connectionById.get(row.connection_id as string | null ?? "");
    // No silent "claude-code" default here: guessing the wrong agent is
    // exactly the bug this owner-resolution rework fixed (a session got
    // mislabeled "Codex" from an arbitrary channel participant). An
    // unresolved connection shows as "Agent", never a guessed kind.
    const agentLabel = connection?.agent_kind ? agentLabelFor(connection.agent_kind as string) : "Agent";
    const kind = (connection?.agent_kind as string | undefined) ?? "__unresolved__";
    const needsOwner = (kindCounts.get(kind) ?? 0) > 1;
    const ownerLabel = needsOwner && connection?.created_by
      ? `${ownerLabelById.get(connection.created_by as string) ?? "Someone"}'s ${agentLabel}`
      : agentLabel;
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      conversationTopic: topicById.get(row.conversation_id as string) ?? "channel",
      connectionId: row.connection_id as string | null,
      ownerLabel,
      title: row.title as string,
      status: row.status as SessionStatus,
      anchorMessageId: row.anchor_message_id as string | null,
      latestMessageId: row.latest_message_id as string | null,
      startedAtMs: Date.parse(row.created_at as string),
      lastActivityAtMs: Date.parse(row.last_activity_at as string),
      archiveProposed: !!row.archive_proposed_at,
      archivedAtMs: row.archived_at ? Date.parse(row.archived_at as string) : null,
    } satisfies DashboardSession;
  });
}

function agentLabelFor(agentKind: string): string {
  return agentKind === "claude-code" ? "Claude"
    : agentKind === "codex" ? "Codex"
      : agentKind === "grok-build" ? "Grok Build"
        : agentKind === "opencode" ? "OpenCode"
          : agentKind;
}

/**
 * The agent-proposed half of "agent-proposed, human-confirmed" archiving.
 * A session that's been waiting (terminal, no new turns) for the idle
 * threshold with no proposal yet gets one: a real, visible in-channel
 * message posted as that session's own agent connection, plus a flag on
 * the row the Live Sessions panel surfaces with Confirm/Keep-open actions.
 * Nothing archives here -- only an explicit human confirmation does that.
 */
async function proposeArchiveForIdleSessions(workspaceId: string, db: ReturnType<typeof requireService>) {
  const count = await flagIdleSessionsForArchiveProposal(db, workspaceId);
  void count;
}

/**
 * Real shared implementation behind both paths that flag idle sessions:
 * the per-request sync above (scoped to whichever workspace the dashboard
 * viewer is in, `workspaceId` set) and the scheduled sweep below (every
 * workspace at once, `workspaceId` omitted) -- see #16 in
 * M9R_MASTER_BUILD_PLAN.md. Before this, idle sessions in a workspace with
 * nobody currently viewing the dashboard never got flagged at all, since
 * the only call site was this same function gated behind a live GET to
 * /api/dashboard/live-sessions.
 */
async function flagIdleSessionsForArchiveProposal(db: ReturnType<typeof requireService>, workspaceId?: string): Promise<number> {
  let query = db
    .from("conversation_sessions")
    .select("id, conversation_id, connection_id, title, last_activity_at")
    .eq("status", "waiting")
    .is("archive_proposed_at", null)
    // A human dismissal ("Keep open") must actually stick until there's new
    // activity -- without this, the same session got re-flagged on the very
    // next poll a few seconds later, since idleness alone was the only
    // condition and dismissing only cleared archive_proposed_at.
    .is("archive_dismissed_at", null)
    .lte("last_activity_at", new Date(Date.now() - IDLE_BEFORE_ARCHIVE_PROPOSAL_MS).toISOString());
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data: candidates } = await query;
  if (!candidates || candidates.length === 0) return 0;

  // STOPPED: this used to insert a "notice" message directly into
  // conversation_messages, tagged as sent by the session's own (real,
  // live-connected) agent connection. That is indistinguishable from a
  // genuine new agent message to whatever is watching the channel for
  // this connection -- confirmed live to trigger a real new agent turn in
  // response, which created a new workspace_turn_timing_events row, which
  // this same sync then read back as a brand-new session. That is a
  // feedback loop, not a cosmetic bug: it was spawning real unwanted agent
  // activity every time it tried to propose an archive. Disabled until the
  // in-channel proposal is redesigned to not look like a live agent
  // message to the rest of the system (e.g. a dedicated non-agent system
  // sender, or no chat message at all -- flag-only, surfaced purely in the
  // Live Sessions panel). For now this only sets the flag the panel reads;
  // it never writes to conversation_messages.
  for (const candidate of candidates) {
    await db.from("conversation_sessions").update({
      archive_proposed_at: new Date().toISOString(),
      archive_proposed_message_id: null,
    }).eq("id", candidate.id);
  }
  return candidates.length;
}

/**
 * Cron-facing entry point (see vercel.json + /api/internal/idle-session-sweep):
 * flags idle sessions across every workspace, not just the one whose
 * dashboard happens to be open right now.
 */
export async function sweepIdleSessionArchiveProposals(): Promise<{ flagged: number }> {
  const db = requireService();
  const flagged = await flagIdleSessionsForArchiveProposal(db);
  return { flagged };
}

export async function confirmArchiveSession(sessionId: string): Promise<void> {
  const context = await dashboardUserContext();
  const db = requireService();
  const { error } = await db.from("conversation_sessions").update({
    status: "archived",
    archived_at: new Date().toISOString(),
    archived_by_user_id: context.user.id,
  }).eq("id", sessionId).eq("workspace_id", context.workspaceId);
  if (error) throw new Error("Could not archive this session.");
}

export async function dismissArchiveProposal(sessionId: string): Promise<void> {
  const context = await dashboardUserContext();
  const db = requireService();
  const { error } = await db.from("conversation_sessions").update({
    archive_proposed_at: null,
    archive_proposed_message_id: null,
    // Suppresses re-proposing until this session sees new activity (which
    // clears this again) -- "Keep open" has to actually mean that.
    archive_dismissed_at: new Date().toISOString(),
  }).eq("id", sessionId).eq("workspace_id", context.workspaceId);
  if (error) throw new Error("Could not dismiss the archive proposal.");
}

/** Manual archive: a human can archive early, without waiting for the agent's proposal. */
export async function manualArchiveSession(sessionId: string): Promise<void> {
  return confirmArchiveSession(sessionId);
}

export interface ArchivedSessionDetail extends DashboardSession {
  agentLabel: string;
  transcript: Array<{ id: string; sender: string; body: string; createdAtMs: number }>;
  messageCount: number;
}

/**
 * Item #30's session-browser detail view (the Mosaic-style click-into-a-
 * session page, re-verified frame by frame): dashboard-auth (a signed-in
 * human, not a bearer-token agent) counterpart to searchArchivedSessionsForAgent
 * above -- same transcript data, but scoped to the human's own workspace via
 * cookie session and returning the FULL transcript (a person reading their
 * own team's history has no token-budget reason to see a truncated excerpt),
 * plus the metadata fields the real Mosaic detail panel showed on screen
 * (Agent, Owner, Started, Messages count).
 */
export async function getArchivedSessionForDashboard(sessionId: string): Promise<ArchivedSessionDetail | null> {
  const context = await dashboardUserContext();
  const db = requireService();
  const { data: row } = await db
    .from("conversation_sessions")
    .select("id, conversation_id, connection_id, owner_user_id, title, status, anchor_message_id, latest_message_id, message_ids, created_at, last_activity_at, archived_at, archive_proposed_at")
    .eq("workspace_id", context.workspaceId)
    .eq("id", sessionId)
    .eq("status", "archived")
    .maybeSingle();
  if (!row) return null;
  const [display] = await attachDisplayFields(context.workspaceId, db, [row]);
  const connection = row.connection_id
    ? (await db.from("agent_connections").select("agent_kind, created_by").eq("id", row.connection_id as string).maybeSingle()).data
    : null;
  // The Sessions browser's "Owner" field means the real human who connected
  // this agent (Mosaic's own detail view shows a person's @handle here) --
  // display.ownerLabel instead answers "how should this pane be labeled,"
  // which collapses to the agent's own name when there's only one connection
  // of that kind in the workspace. Using it here would show "Owner: Claude"
  // next to "Agent: Claude", which reads as a bug, not a feature.
  const humanOwnerLabel = connection?.created_by
    ? ((await db.from("users").select("email, name").eq("id", connection.created_by as string).maybeSingle()).data)
    : null;
  const messageIds = (row.message_ids as string[] | null) ?? [];
  const { data: messages } = messageIds.length > 0
    ? await db.from("conversation_messages").select("id, sender_display_name, body, created_at").in("id", messageIds).order("created_at", { ascending: true })
    : { data: [] as Array<Record<string, unknown>> };
  const transcript = (messages ?? []).map((message) => ({
    id: message.id as string,
    sender: (message.sender_display_name as string | null) ?? "Agent",
    body: (message.body as string | null) ?? "",
    createdAtMs: Date.parse(message.created_at as string),
  }));
  return {
    ...display,
    ownerLabel: (humanOwnerLabel?.name as string | null) || (humanOwnerLabel?.email as string | null)?.split("@")[0] || display.ownerLabel,
    agentLabel: connection?.agent_kind ? agentLabelFor(connection.agent_kind as string) : "Agent",
    transcript,
    messageCount: transcript.length,
  };
}

/** Every message id that belongs to any archived session in a set of conversations -- used to filter the channel feed. */
export async function archivedMessageIdsFor(workspaceId: string, conversationIds: string[]): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const db = requireService();
  const { data } = await db
    .from("conversation_sessions")
    .select("message_ids")
    .eq("workspace_id", workspaceId)
    .eq("status", "archived")
    .in("conversation_id", conversationIds);
  const ids = new Set<string>();
  for (const row of data ?? []) {
    for (const id of (row.message_ids as string[] | null) ?? []) ids.add(id);
  }
  return ids;
}

/**
 * M9R_MASTER_BUILD_PLAN.md items #1's flagged fast-follow ("agent recall of
 * an archived session") and #11/#29 (memory as structured markdown files /
 * the Mosaic-proven shared-context catalog) converge on the same real
 * primitive: an archived Session is already a durable, titled, bounded
 * transcript -- exactly what a "past work" search needs -- so this is a
 * search over conversation_sessions, not a new store. Called by both the
 * agent-facing search_memory MCP tool (live, cross-machine, works the
 * instant a session archives) and the local markdown exporter below (the
 * Jake Van Clief "second brain" file half, for an agent's own plain
 * read/grep tools once exported).
 */
export interface PastSessionMatch {
  id: string;
  conversationId: string;
  conversationTopic: string;
  ownerLabel: string;
  title: string;
  archivedAtMs: number | null;
  /** Chronological, bounded excerpt -- not the full transcript, so a match doesn't blow the calling agent's context. */
  transcript: Array<{ sender: string; body: string }>;
}

const MEMORY_SEARCH_TRANSCRIPT_MESSAGES = 8;
const MEMORY_SEARCH_MESSAGE_MAX_CHARS = 600;

export async function searchArchivedSessionsForAgent(workspaceId: string, rawQuery: string, limit = 8): Promise<PastSessionMatch[]> {
  const db = requireService();
  // Same sanitize-then-bound pattern as searchDashboardWorkspace (conversation-service.ts) --
  // strips ILIKE wildcard metacharacters out of user/agent-supplied text so a query can't turn
  // into an unbounded/forged pattern, then bounds length so a pathological query can't blow the request up.
  const q = rawQuery.replace(/[%_]/g, "").trim().slice(0, 160);
  const boundedLimit = Math.max(1, Math.min(limit, 25));

  let sessionRows: Array<Record<string, unknown>> = [];
  if (!q) {
    // No query: "what have we worked on" -- most recently archived first.
    const { data } = await db.from("conversation_sessions").select("id, conversation_id, connection_id, owner_user_id, title, message_ids, archived_at")
      .eq("workspace_id", workspaceId).eq("status", "archived").order("archived_at", { ascending: false }).limit(boundedLimit);
    sessionRows = data ?? [];
  } else {
    const [{ data: byTitle }, { data: matchingMessages }] = await Promise.all([
      db.from("conversation_sessions").select("id, conversation_id, connection_id, owner_user_id, title, message_ids, archived_at")
        .eq("workspace_id", workspaceId).eq("status", "archived").ilike("title", `%${q}%`).order("archived_at", { ascending: false }).limit(boundedLimit),
      // A session's title is a short summary of what STARTED it -- it won't mention
      // every topic discussed inside, so also catch a session by the actual body text
      // of any message it contains, the same way a real search would.
      db.from("conversation_messages").select("id").eq("workspace_id", workspaceId).ilike("body", `%${q}%`).limit(200),
    ]);
    const byId = new Map((byTitle ?? []).map((row) => [row.id as string, row]));
    const matchingMessageIds = (matchingMessages ?? []).map((row) => row.id as string);
    if (matchingMessageIds.length > 0 && byId.size < boundedLimit) {
      const { data: byBody } = await db.from("conversation_sessions").select("id, conversation_id, connection_id, owner_user_id, title, message_ids, archived_at")
        .eq("workspace_id", workspaceId).eq("status", "archived").overlaps("message_ids", matchingMessageIds).order("archived_at", { ascending: false }).limit(boundedLimit);
      for (const row of byBody ?? []) if (!byId.has(row.id as string)) byId.set(row.id as string, row);
    }
    sessionRows = [...byId.values()].slice(0, boundedLimit);
  }
  if (sessionRows.length === 0) return [];

  const displaySessions = await attachDisplayFields(workspaceId, db, sessionRows);
  const displayById = new Map(displaySessions.map((s) => [s.id, s]));

  // One bounded query for every matched session's transcript excerpt, not N+1 --
  // matched sessions here are already capped at boundedLimit (<=25).
  const allMessageIds = [...new Set(sessionRows.flatMap((row) => ((row.message_ids as string[] | null) ?? [])))];
  const { data: messages } = allMessageIds.length > 0
    ? await db.from("conversation_messages").select("id, conversation_id, sender_display_name, body, created_at").in("id", allMessageIds).order("created_at", { ascending: true })
    : { data: [] as Array<Record<string, unknown>> };
  const messagesByConversation = new Map<string, Array<{ id: string; sender: string; body: string }>>();
  for (const message of messages ?? []) {
    const conversationId = message.conversation_id as string;
    const list = messagesByConversation.get(conversationId) ?? [];
    list.push({
      id: message.id as string,
      sender: (message.sender_display_name as string | null) ?? "Agent",
      body: ((message.body as string | null) ?? "").slice(0, MEMORY_SEARCH_MESSAGE_MAX_CHARS),
    });
    messagesByConversation.set(conversationId, list);
  }

  return sessionRows.map((row) => {
    const sessionId = row.id as string;
    const display = displayById.get(sessionId);
    const messageIds = new Set((row.message_ids as string[] | null) ?? []);
    const transcript = (messagesByConversation.get(row.conversation_id as string) ?? [])
      .filter((message) => messageIds.has(message.id))
      .slice(0, MEMORY_SEARCH_TRANSCRIPT_MESSAGES)
      .map(({ sender, body }) => ({ sender, body }));
    return {
      id: sessionId,
      conversationId: row.conversation_id as string,
      conversationTopic: display?.conversationTopic ?? "channel",
      ownerLabel: display?.ownerLabel ?? "Agent",
      title: display?.title ?? (row.title as string) ?? "Untitled session",
      archivedAtMs: display?.archivedAtMs ?? null,
      transcript,
    };
  });
}

export interface ExportableSession extends PastSessionMatch {
  archivedAtIso: string;
}

const MEMORY_EXPORT_PAGE_SIZE = 50;
// Full fidelity for the on-disk file, not the context-budget-bounded excerpt
// searchArchivedSessionsForAgent returns -- a markdown file on the user's own
// disk has no per-call token cost to bound against.
const MEMORY_EXPORT_MESSAGE_MAX_CHARS = 20_000;

/**
 * The Jake Van Clief "second brain" half: every archived Session this
 * workspace has produced since `sinceIso` (exclusive), oldest first, full
 * transcript -- for `m9r-cli memory export`'s local markdown writer. Not
 * reusing searchArchivedSessionsForAgent's context-bounded excerpt above;
 * this is meant to be the durable record on disk, so it keeps the whole
 * thing.
 */
export async function listArchivedSessionsForExport(workspaceId: string, sinceIso: string | null): Promise<ExportableSession[]> {
  const db = requireService();
  let query = db.from("conversation_sessions").select("id, conversation_id, connection_id, owner_user_id, title, message_ids, archived_at")
    .eq("workspace_id", workspaceId).eq("status", "archived").order("archived_at", { ascending: true }).limit(MEMORY_EXPORT_PAGE_SIZE);
  if (sinceIso) query = query.gt("archived_at", sinceIso);
  const { data: sessionRows } = await query;
  if (!sessionRows || sessionRows.length === 0) return [];

  const displaySessions = await attachDisplayFields(workspaceId, db, sessionRows);
  const displayById = new Map(displaySessions.map((s) => [s.id, s]));
  const allMessageIds = [...new Set(sessionRows.flatMap((row) => ((row.message_ids as string[] | null) ?? [])))];
  const { data: messages } = allMessageIds.length > 0
    ? await db.from("conversation_messages").select("id, conversation_id, sender_display_name, body, created_at").in("id", allMessageIds).order("created_at", { ascending: true })
    : { data: [] as Array<Record<string, unknown>> };
  const messagesByConversation = new Map<string, Array<{ id: string; sender: string; body: string }>>();
  for (const message of messages ?? []) {
    const conversationId = message.conversation_id as string;
    const list = messagesByConversation.get(conversationId) ?? [];
    list.push({
      id: message.id as string,
      sender: (message.sender_display_name as string | null) ?? "Agent",
      body: ((message.body as string | null) ?? "").slice(0, MEMORY_EXPORT_MESSAGE_MAX_CHARS),
    });
    messagesByConversation.set(conversationId, list);
  }

  return sessionRows.map((row) => {
    const sessionId = row.id as string;
    const display = displayById.get(sessionId);
    const messageIds = new Set((row.message_ids as string[] | null) ?? []);
    const transcript = (messagesByConversation.get(row.conversation_id as string) ?? [])
      .filter((message) => messageIds.has(message.id))
      .map(({ sender, body }) => ({ sender, body }));
    const archivedAtIso = (row.archived_at as string | null) ?? new Date(0).toISOString();
    return {
      id: sessionId,
      conversationId: row.conversation_id as string,
      conversationTopic: display?.conversationTopic ?? "channel",
      ownerLabel: display?.ownerLabel ?? "Agent",
      title: display?.title ?? (row.title as string) ?? "Untitled session",
      archivedAtMs: display?.archivedAtMs ?? Date.parse(archivedAtIso),
      archivedAtIso,
      transcript,
    };
  });
}
