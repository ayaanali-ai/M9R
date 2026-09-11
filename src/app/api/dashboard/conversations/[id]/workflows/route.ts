import { NextRequest, NextResponse } from "next/server";
import { createDashboardChannelWorkflow, listDashboardChannelWorkflows, setDashboardChannelWorkflowEnabled, deleteDashboardChannelWorkflow } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const workflows = await listDashboardChannelWorkflows(id);
    return NextResponse.json({ workflows });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { definitionYaml?: unknown } | null;
  if (typeof body?.definitionYaml !== "string" || !body.definitionYaml.trim()) {
    return NextResponse.json({ error: "definitionYaml is required." }, { status: 400 });
  }
  try {
    const workflow = await createDashboardChannelWorkflow({ conversationId: id, definitionYaml: body.definitionYaml });
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { workflowId?: unknown; enabled?: unknown } | null;
  if (typeof body?.workflowId !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "workflowId and enabled are required." }, { status: 400 });
  }
  try {
    await setDashboardChannelWorkflowEnabled({ conversationId: id, workflowId: body.workflowId, enabled: body.enabled });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflowId = request.nextUrl.searchParams.get("workflowId");
  if (!workflowId) return NextResponse.json({ error: "workflowId is required." }, { status: 400 });
  try {
    await deleteDashboardChannelWorkflow({ conversationId: id, workflowId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
