import { NextRequest, NextResponse } from "next/server";
import {
  getActiveWorkspaceIdentity,
  setActiveWorkspaceIdentity,
  WorkspaceIdentityError,
} from "@/lib/workspace-identity-service";

// ---------------------------------------------------------------------------
// GET  /api/workspace/identity — the active workspace's mission record.
// PUT  /api/workspace/identity — set it. Body: { mission: string }
// Owner-only: enforced by workspace_identity's own RLS policy, not app code.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const identity = await getActiveWorkspaceIdentity();
    return NextResponse.json({ ok: true, identity });
  } catch (err) {
    return handle(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    let body: { mission?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (typeof body.mission !== "string") {
      return NextResponse.json({ error: "mission is required." }, { status: 400 });
    }
    const identity = await setActiveWorkspaceIdentity(body.mission);
    return NextResponse.json({ ok: true, identity });
  } catch (err) {
    return handle(err);
  }
}

function handle(err: unknown) {
  if (err instanceof WorkspaceIdentityError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("Workspace identity error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
