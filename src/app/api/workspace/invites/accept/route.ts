import { NextRequest, NextResponse } from "next/server";
import { acceptWorkspaceInvite, WorkspaceMembershipError } from "@/lib/workspace-membership-service";
import { ACTIVE_PROJECT_COOKIE, ACTIVE_PROJECT_COOKIE_OPTIONS } from "@/lib/active-project";

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
    // Land the new member in the workspace they just joined -- without this,
    // resolveActiveOrDefaultProjectId's cookie check finds nothing and falls
    // back to "oldest workspace I own" (their own personal default), so
    // accepting an invite silently didn't switch anyone into the shared
    // workspace at all. Verified live: this was a real bug, not theoretical.
    const res = NextResponse.json({ ok: true, ...result });
    res.cookies.set(ACTIVE_PROJECT_COOKIE, result.workspaceId, ACTIVE_PROJECT_COOKIE_OPTIONS);
    return res;
  } catch (err) {
    if (err instanceof WorkspaceMembershipError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace invite accept error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
