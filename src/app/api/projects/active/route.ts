import { NextRequest, NextResponse } from "next/server";
import { userOwnsProject, ProjectsServiceError } from "@/lib/projects-service";
import { ACTIVE_PROJECT_COOKIE, ACTIVE_PROJECT_COOKIE_OPTIONS } from "@/lib/active-project";

// ---------------------------------------------------------------------------
// POST /api/projects/active — switch the active workspace. Body: { projectId }
//
// Verifies the project belongs to the signed-in user before writing the cookie,
// so a user can't pin themselves to a workspace they don't own.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    let body: { projectId?: string };
    try {
      body = (await req.json()) as { projectId?: string };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const projectId = String(body.projectId ?? "");
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required." }, { status: 400 });
    }
    if (!(await userOwnsProject(projectId))) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    }

    const res = NextResponse.json({ ok: true, activeProjectId: projectId });
    res.cookies.set(ACTIVE_PROJECT_COOKIE, projectId, ACTIVE_PROJECT_COOKIE_OPTIONS);
    return res;
  } catch (err) {
    if (err instanceof ProjectsServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Switch project error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
