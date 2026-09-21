/**
 * Agent dashboard presenter (pure)
 * ----------------------------------------------------------------------------
 * IO-free helpers that keep /dashboard/agents strictly truthful:
 *  - de-duplicate connected agents so historical test rows don't look like many
 *    separate live agents,
 *  - classify connection liveness honestly (active / stale / not-seen),
 *  - tell run-linked sessions from unlinked ones.
 *
 * Kept separate from the React page so the truthfulness rules are unit-testable.
 */

import { RECENT_CONNECTION_MAX_AGE_MS } from "@/lib/conversation-routing";

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  agent_kind: string;
  repo_hint: string;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  model?: string | null;
  available_models?: { id: string; label: string }[] | null;
  /** agent_connections.last_provider_session_ref: the provider's own id for the newest session M9R started. */
  last_provider_session_ref?: string | null;
  /** Who connected this agent (agent_connections.created_by). Null for older
   * rows predating that column's use, or a connection nobody attributed. */
  created_by?: string | null;
  /** Custom display name (agent_connections.display_name). */
  display_name?: string | null;
  /** Short role/title (agent_connections.title). */
  title?: string | null;
  /** Custom avatar URL (agent_connections.avatar_url). */
  avatar_url?: string | null;
  /** Mascot body variant (agent_connections.mascot_body). */
  mascot_body?: string | null;
  /** TTS voice identifier (agent_connections.voice). */
  voice?: string | null;
  /** Speak replies aloud (agent_connections.speak_replies). */
  speak_replies?: boolean | null;
  /** Standing instructions (agent_connections.soul). */
  soul?: string | null;
  /** Team section (agent_connections.section). */
  section?: string | null;
  /** Chief of Staff flag (agent_connections.chief_of_staff). */
  chief_of_staff?: boolean | null;
  /** Managed sections for Chiefs (agent_connections.managed_sections). */
  managed_sections?: string[] | null;
  /** Explicit peer allow-list (agent_connections.peers). */
  peers?: string[] | null;
  /** Resolved owner display name (from created_by join). */
  owner_label?: string | null;
  /** Raw owner user ID (agent_connections.created_by). */
  owner_user_id?: string | null;
}

export type ConnectionLiveness = "active" | "stale" | "not_seen";

/**
 * A connection is live only while its server-issued heartbeat lease is fresh.
 * The presence contract grants a single 90-second lease. That same boundary
 * is shared with message routing so the dashboard never calls a connection
 * live that the bridge would refuse to route to.
 */
export const STALE_AFTER_MS = RECENT_CONNECTION_MAX_AGE_MS;

/**
 * Classify a connection's liveness from last_seen_at. Never reports a stale or
 * never-seen connection as an active live agent.
 */
export function connectionLiveness(lastSeenAt: string | null, now = Date.now()): ConnectionLiveness {
  if (!lastSeenAt) return "not_seen";
  const seen = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seen)) return "not_seen";
  return now - seen > STALE_AFTER_MS ? "stale" : "active";
}

/**
 * `status = active` is durable database state, not proof that a process is
 * still listening. Live routing requires a recent heartbeat; old rows remain
 * active until explicitly revoked so the audit trail is preserved.
 */
export function isRecentlySeenConnection(connection: Pick<ConnectionRow, "last_seen_at">, now = Date.now()): boolean {
  return connectionLiveness(connection.last_seen_at, now) === "active";
}

export const LIVENESS_LABEL: Record<ConnectionLiveness, string> = {
  active: "active / recently seen",
  stale: "stale",
  not_seen: "connected, not seen yet",
};

export interface ConnectionGroup {
  key: string;
  repo_hint: string;
  agent_kind: string;
  /** The most recent connection in this group. */
  latest: ConnectionRow;
  liveness: ConnectionLiveness;
  /** How many connections in this group (including the latest). */
  total: number;
}

export interface DedupedConnections {
  groups: ConnectionGroup[];
  /** Connections hidden because they are older duplicates within their group. */
  hiddenCount: number;
}

/** Sort key: most recent last_seen_at, then created_at. Nulls sort last. */
function recencyTs(c: ConnectionRow): number {
  const seen = c.last_seen_at ? new Date(c.last_seen_at).getTime() : NaN;
  if (Number.isFinite(seen)) return seen;
  const created = new Date(c.created_at).getTime();
  return Number.isFinite(created) ? created : 0;
}

/**
 * Group connections by durable workspace_id + canonical agent_kind and keep the
 * most recent one per group. A repo_hint is display metadata, not identity: it
 * may change after a rename or checkout switch without creating a new callsign.
 */
export function dedupeConnections(
  connections: ConnectionRow[],
  now = Date.now(),
  options: { preserveDistinctConnections?: boolean } = {},
): DedupedConnections {
  const byKey = new Map<string, ConnectionRow[]>();
  for (const c of connections) {
    const key = options.preserveDistinctConnections
      ? `${(c.workspace_id || "workspace").trim().toLowerCase()}||${c.id}`
      : `${(c.workspace_id || "workspace").trim().toLowerCase()}||${(c.agent_kind || "agent").trim().toLowerCase()}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }

  const groups: ConnectionGroup[] = [];
  let hiddenCount = 0;
  for (const [key, list] of byKey) {
    list.sort((a, b) => recencyTs(b) - recencyTs(a));
    const latest = list[0];
    hiddenCount += list.length - 1;
    groups.push({
      key,
      repo_hint: latest.repo_hint || "workspace",
      agent_kind: latest.agent_kind || "agent",
      latest,
      liveness: connectionLiveness(latest.last_seen_at, now),
      total: list.length,
    });
  }

  groups.sort((a, b) => recencyTs(b.latest) - recencyTs(a.latest));
  return { groups, hiddenCount };
}

// ---------------------------------------------------------------------------
// Sessions: run-linked vs unlinked
// ---------------------------------------------------------------------------

export interface SessionLinkInfo {
  /** The run id this session is attached to, or null when unlinked. */
  runId: string | null;
  linked: boolean;
}

/**
 * Build a map of session id → the run that links it (via latest_session_id).
 * Sessions not referenced by any run are "unlinked".
 */
export function sessionRunLinks(
  runs: Array<{ id: string; latest_session_id: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of runs) {
    const sessionId = r.latest_session_id?.trim();
    if (sessionId) map.set(sessionId, r.id);
  }
  return map;
}

export function sessionLink(sessionId: string, links: Map<string, string>): SessionLinkInfo {
  const runId = links.get(sessionId.trim()) ?? null;
  return { runId, linked: runId !== null };
}

/** Short, stable id for display (first 8 chars). */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Split sessions into those attached to a visible agent run (latest_session_id)
 * and "legacy/unlinked" ones. The main dashboard shows only the linked set so
 * old test rows can't masquerade as current activity.
 */
export function partitionSessionsByLink<S extends { id: string }>(
  sessions: S[],
  links: Map<string, string>,
): { linked: S[]; unlinked: S[] } {
  const linked: S[] = [];
  const unlinked: S[] = [];
  for (const s of sessions) {
    (links.has(s.id) ? linked : unlinked).push(s);
  }
  return { linked, unlinked };
}

/**
 * The set of session ids that are attached to a run. A recommendation is
 * "run-linked" when its source session id is in this set.
 */
export function linkedSessionIdSet(
  runs: Array<{ latest_session_id: string | null }>,
): Set<string> {
  const set = new Set<string>();
  for (const r of runs) if (r.latest_session_id) set.add(r.latest_session_id);
  return set;
}

/**
 * Split recommendations into run-linked vs legacy/unlinked using the source
 * session id stored on each recommendation (source_report_id). Recommendations
 * with no source session id, or one not attached to a visible run, are legacy.
 */
export function partitionRecommendationsByLink<R extends { sourceReportId: string | null }>(
  recommendations: R[],
  linkedSessionIds: Set<string>,
): { linked: R[]; legacy: R[] } {
  const linked: R[] = [];
  const legacy: R[] = [];
  for (const r of recommendations) {
    (r.sourceReportId && linkedSessionIds.has(r.sourceReportId) ? linked : legacy).push(r);
  }
  return { linked, legacy };
}
