import { NextRequest, NextResponse } from "next/server";
import {
  listProjects,
  createProject,
  getCurrentWorkspacePlanUsage,
  ProjectsServiceError,
} from "@/lib/projects-service";
import { PlanLimitError } from "@/lib/plan-limits-service";

// ---------------------------------------------------------------------------
// GET  /api/projects — list the signed-in user's workspaces.
// POST /api/projects — create a workspace. Body: { name, description? }
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const [projects, usage] = await Promise.all([
      listProjects(),
      getCurrentWorkspacePlanUsage(),
    ]);
    return NextResponse.json({ ok: true, projects, usage });
  } catch (err) {
    if (err instanceof ProjectsServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("List projects error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: { name?: string; description?: string };
    try {
      body = (await req.json()) as { name?: string; description?: string };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const project = await createProject(String(body.name ?? ""), body.description);
    const usage = await getCurrentWorkspacePlanUsage();
    return NextResponse.json({ ok: true, project, usage }, { status: 201 });
  } catch (err) {
    if (err instanceof PlanLimitError) {
      return NextResponse.json({ error: err.message, code: err.code, usage: err.usage }, { status: err.status });
    }
    if (err instanceof ProjectsServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Create project error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
