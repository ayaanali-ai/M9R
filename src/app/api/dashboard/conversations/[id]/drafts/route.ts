import { NextRequest, NextResponse } from "next/server";
import { listDraftsForDashboard, writeDraftSectionForDashboard, setDraftStatusForDashboard } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

// #13 shared co-drafting, dashboard side.
// GET   — every draft in this conversation, sections included.
// POST  — the human's own contribution: write (create-or-revise) a section.
// PATCH — mark a draft ready (locks it against further section writes).

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const drafts = await listDraftsForDashboard(id);
    return NextResponse.json({ drafts });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { draftTitle?: unknown; heading?: unknown; body?: unknown } | null;
  if (typeof body?.draftTitle !== "string" || typeof body?.heading !== "string" || typeof body?.body !== "string") {
    return NextResponse.json({ error: "draftTitle, heading, and body are all required strings." }, { status: 400 });
  }
  try {
    const draft = await writeDraftSectionForDashboard({ conversationId: id, draftTitle: body.draftTitle, heading: body.heading, body: body.body });
    return NextResponse.json({ draft }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { draftId?: unknown; status?: unknown } | null;
  if (typeof body?.draftId !== "string" || (body?.status !== "draft" && body?.status !== "ready")) {
    return NextResponse.json({ error: "draftId and a valid status (\"draft\" or \"ready\") are required." }, { status: 400 });
  }
  try {
    await setDraftStatusForDashboard({ conversationId: id, draftId: body.draftId, status: body.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
