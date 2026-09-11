import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { resolveMissionPrincipal, type MissionPrincipal, type ResolvePrincipalOptions } from "@/lib/mission/mission-principal";

/** Shared helpers for /api/missions/* routes — one principal resolver, one error mapper, matching the /api/agent/* convention (see ../agent/_shared.ts) but keyed to Mission's own typed error taxonomy. */

export async function withMissionPrincipal(req: NextRequest, options: ResolvePrincipalOptions = {}): Promise<MissionPrincipal> {
  return resolveMissionPrincipal(req, options);
}

export function handleMissionApiError(err: unknown): NextResponse {
  if (err instanceof MissionApiError) {
    return NextResponse.json(
      { error: err.message, code: err.code, correlationId: err.correlationId, detail: err.detail },
      { status: err.status },
    );
  }
  console.error("Mission API route error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error.", code: "internal_error" }, { status: 500 });
}

export function queryWorkspaceId(req: NextRequest): string | null {
  return req.nextUrl.searchParams.get("workspaceId");
}
