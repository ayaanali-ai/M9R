/**
 * Mission API principal resolution — the ONE place an `/api/missions/*`
 * route turns an incoming request into (a) a Mission `EventActor` and
 * (b) an authorized workspace id. Reuses the two trust paths already
 * established by /api/agent/* (see mission-application-service.ts's
 * header comment) rather than inventing a third:
 *
 *  - Cookie session (dashboard, human): `createClient()` + `auth.getUser()`.
 *    Resolves to `{kind: "human"}`. Workspace is either the caller's
 *    explicit `workspaceId` (ownership verified via `userOwnsProject`) or
 *    the active/default workspace for that user.
 *  - Bearer token (agent/provider): `authenticateAgent`. Resolves to
 *    `{kind: "agent"}`, workspace is whatever the token is bound to — a
 *    bearer caller can never act on a workspace other than its own token's.
 *
 * `requireHuman: true` (review decisions) refuses a bearer-authenticated
 * caller outright — a provider credential can poll status but can never
 * decide a human review, no matter what it claims about itself.
 */

import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateAgent, bearerFrom, type AuthedAgent } from "@/lib/agent-join-service";
import { resolveActiveOrDefaultProjectId, userOwnsProject } from "@/lib/projects-service";
import type { EventActor } from "./mission-events";
import { MissionApiError } from "./mission-application-errors";

export interface MissionPrincipal {
  actor: EventActor;
  workspaceId: string;
  /** 'system' is never resolved from a request (resolveMissionPrincipal only ever returns human/agent) — it's built directly by an internal, unattended caller like workflow-scheduler-service.ts's periodic sweep, where there is no request to authenticate. */
  kind: "human" | "agent" | "system";
  userId: string | null;
  agent: AuthedAgent | null;
}

export interface ResolvePrincipalOptions {
  /** Explicit workspace requested by the caller (e.g. a query/body param). Cookie callers only — bearer callers are always scoped to their token's workspace. */
  requestedWorkspaceId?: string | null;
  /** Refuse a bearer-authenticated (agent/provider) caller — used for review decisions, which only a human may record. */
  requireHuman?: boolean;
}

async function resolveHumanPrincipal(options: ResolvePrincipalOptions): Promise<MissionPrincipal> {
  const db = await createClient();
  if (!db) throw new MissionApiError("M9R is not configured.", "backend_not_configured", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new MissionApiError("Sign in to use the Mission API.", "unauthenticated", 401);

  let workspaceId = options.requestedWorkspaceId?.trim() || null;
  if (workspaceId) {
    const owns = await userOwnsProject(workspaceId);
    if (!owns) {
      // Never reveal whether the workspace id exists at all — same refusal
      // as "not resolved", not a 403 that would confirm existence.
      throw new MissionApiError("Workspace was not found.", "workspace_not_resolved", 404);
    }
  } else {
    workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email, name: (user.user_metadata?.name as string | undefined) ?? null });
  }

  return {
    actor: { kind: "human", id: user.id },
    workspaceId,
    kind: "human",
    userId: user.id,
    agent: null,
  };
}

export async function resolveMissionPrincipal(req: NextRequest, options: ResolvePrincipalOptions = {}): Promise<MissionPrincipal> {
  const bearer = bearerFrom(req.headers.get("authorization"));
  if (bearer) {
    if (options.requireHuman) {
      throw new MissionApiError("Bearer-authenticated callers cannot record a human review decision.", "human_required", 403);
    }
    const agent = await authenticateAgent(bearer);
    if (!agent) {
      throw new MissionApiError("Invalid or expired agent token.", "unauthenticated", 401);
    }
    return {
      actor: { kind: "agent", id: agent.connectionId },
      workspaceId: agent.workspaceId,
      kind: "agent",
      userId: null,
      agent,
    };
  }

  return resolveHumanPrincipal(options);
}

/**
 * Server-component variant for dashboard pages that render Mission data
 * directly (no HTTP round-trip to `/api/missions/*`, the same way other
 * dashboard pages query their data source directly rather than fetching their
 * own API route). There is no bearer path here — a
 * server-rendered dashboard page only ever runs for a cookie-authenticated
 * human, so this is always the human branch of `resolveMissionPrincipal`,
 * factored out rather than routed through a synthetic `NextRequest`.
 */
export async function resolveMissionPrincipalForServerComponent(options: ResolvePrincipalOptions = {}): Promise<MissionPrincipal> {
  return resolveHumanPrincipal(options);
}
