import { NextResponse } from "next/server";
import { enablePublicResume, disablePublicResume } from "@/lib/agent-resume-service";
import { handleAgentError } from "../../agent/_shared";

// ---------------------------------------------------------------------------
// POST /api/resume/[connectionId] — enable this connection's public resume,
// return its share slug.
// DELETE /api/resume/[connectionId] — disable it.
// Cookie-authenticated dashboard actions only; ownership is checked inside
// agent-resume-service.ts before any write.
// ---------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await params;
    const { slug } = await enablePublicResume(connectionId);
    return NextResponse.json({ ok: true, slug });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await params;
    await disablePublicResume(connectionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
