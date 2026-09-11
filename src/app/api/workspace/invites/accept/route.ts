import { NextRequest, NextResponse } from "next/server";
import { acceptWorkspaceInvite, WorkspaceMembershipError } from "@/lib/workspace-membership-service";

// ---------------------------------------------------------------------------
// POST /api/workspace/invites/accept — accept an invite. Body: { token }
// The signed-in user's email must match the invite's -- see
// acceptWorkspaceInvite's own doc comment for why that's the whole check.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    let body: { token?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.token) return NextResponse.json({ error: "token is required." }, { status: 400 });
    const result = await acceptWorkspaceInvite(body.token);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof WorkspaceMembershipError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace invite accept error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
