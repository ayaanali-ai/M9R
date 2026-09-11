import { NextRequest, NextResponse } from "next/server";
import { listDashboardGithubBindings, createDashboardGithubBinding, deleteDashboardGithubBinding } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../_shared";

export async function GET() {
  try {
    const bindings = await listDashboardGithubBindings();
    return NextResponse.json({ bindings });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.repoFullName !== "string" || typeof body.conversationId !== "string") {
    return NextResponse.json({ error: "repoFullName and conversationId are required." }, { status: 400 });
  }
  try {
    const binding = await createDashboardGithubBinding({ repoFullName: body.repoFullName, conversationId: body.conversationId });
    return NextResponse.json({ binding }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    await deleteDashboardGithubBinding(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
