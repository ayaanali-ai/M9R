import { NextRequest, NextResponse } from "next/server";
import { renameActiveWorkspace, activeWorkspaceName, ProjectsServiceError } from "@/lib/projects-service";

// GET /api/workspace/rename — the active workspace's current name.
// PUT /api/workspace/rename — rename the active workspace. Body: { name: string }
// Owner-only: enforced by projects' own UPDATE RLS policy, not app code.

export async function GET() {
  try {
    const name = await activeWorkspaceName();
    return NextResponse.json({ ok: true, name });
  } catch (err) {
    if (err instanceof ProjectsServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace name read error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    let body: { name?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }
    const project = await renameActiveWorkspace(body.name);
    return NextResponse.json({ ok: true, project });
  } catch (err) {
    if (err instanceof ProjectsServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace rename error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
