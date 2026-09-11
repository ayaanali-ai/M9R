/**
 * Public Agent Resume — an opt-in, no-login page showing one connection's
 * real track record: reviewed count, approval rate, standing. Nothing else.
 * No task titles, no workspace name, no repo hints -- the public surface is
 * deliberately aggregate-only so enabling it can never leak private content.
 */

import { randomBytes } from "node:crypto";
import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import {
  buildAgentTrackRecord,
  trackRecordStandingLabel,
  type AgentTrackRecord,
  type TrackRecordPassport,
} from "@/lib/agent-track-record";
import { REVIEW_DECISION_EVENT_TYPE, humanReviewFromEvents, type RunReviewEventRow } from "@/lib/run-review-decision-service";

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

function isMissingColumnError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

/** A short, URL-safe slug -- not a secret, just an opaque public handle. */
function generateShareSlug(): string {
  return randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(10, "0");
}

async function requireOwnedConnection(connectionId: string): Promise<{ workspaceId: string }> {
  const db = await createClient();
  if (!db) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to manage this agent's resume.", "AUTH_REQUIRED", 401);

  const { data: connection, error } = await db
    .from("agent_connections")
    .select("id, workspace_id")
    .eq("id", connectionId)
    .maybeSingle();
  if (error || !connection) throw new AgentJoinError("Connection not found.", "CONNECTION_NOT_FOUND", 404);
  return { workspaceId: connection.workspace_id as string };
}

export async function enablePublicResume(connectionId: string): Promise<{ slug: string }> {
  await requireOwnedConnection(connectionId);
  const service = requireService();
  const slug = generateShareSlug();
  const { error } = await service
    .from("agent_connections")
    .update({ public_share_slug: slug, public_share_enabled_at: new Date().toISOString() })
    .eq("id", connectionId);
  if (error) {
    if (isMissingColumnError(error)) {
      throw new AgentJoinError(
        "Public resumes aren't available yet: the database migration adding public_share_slug hasn't been applied.",
        "MIGRATION_REQUIRED",
        503,
      );
    }
    throw new AgentJoinError("Could not enable the public resume.", "RESUME_SHARE_FAILED", 500);
  }
  return { slug };
}

export async function disablePublicResume(connectionId: string): Promise<void> {
  await requireOwnedConnection(connectionId);
  const service = requireService();
  const { error } = await service
    .from("agent_connections")
    .update({ public_share_slug: null, public_share_enabled_at: null })
    .eq("id", connectionId);
  if (error) throw new AgentJoinError("Could not disable the public resume.", "RESUME_SHARE_FAILED", 500);
}

export interface PublicAgentResume {
  agentKind: string;
  publicSince: string;
  record: AgentTrackRecord;
  standingLabel: string;
}

/** No auth required by design -- the slug is the only thing that gates this, and it returns aggregate counts only. */
export async function getPublicResume(slug: string): Promise<PublicAgentResume | null> {
  const service = requireService();
  const { data: connection, error: connectionError } = await service
    .from("agent_connections")
    .select("id, agent_kind, public_share_enabled_at")
    .eq("public_share_slug", slug)
    .maybeSingle();
  if (connectionError || !connection || !connection.public_share_enabled_at) return null;

  const { data: runs, error: runsError } = await service
    .from("agent_runs")
    .select("id")
    .eq("connection_id", connection.id);
  if (runsError) throw new AgentJoinError("Could not load this resume.", "RESUME_READ_FAILED", 500);
  const runRows = (runs ?? []) as Array<{ id: string }>;
  const runIds = runRows.map((row) => row.id);

  const eventsByRun = new Map<string, RunReviewEventRow[]>();
  if (runIds.length > 0) {
    const { data: events, error: eventsError } = await service
      .from("agent_run_events")
      .select("run_id, event_type, message, created_at")
      .in("run_id", runIds)
      .eq("event_type", REVIEW_DECISION_EVENT_TYPE)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (eventsError) throw new AgentJoinError("Could not load this resume.", "RESUME_READ_FAILED", 500);
    for (const event of (events ?? []) as Array<RunReviewEventRow & { run_id: string }>) {
      const list = eventsByRun.get(event.run_id) ?? [];
      list.push(event);
      eventsByRun.set(event.run_id, list);
    }
  }

  const passports: TrackRecordPassport[] = runRows.map((run) => ({
    run_id: run.id,
    submitted_at: null,
    human_review: humanReviewFromEvents(eventsByRun.get(run.id)),
    evidence: { verification_provenance: [], changed_files: [] },
  }));

  const record = buildAgentTrackRecord(runRows, passports);
  return {
    agentKind: connection.agent_kind as string,
    publicSince: connection.public_share_enabled_at as string,
    record,
    standingLabel: trackRecordStandingLabel(record.standing),
  };
}
