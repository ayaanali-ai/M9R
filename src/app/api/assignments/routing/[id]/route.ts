import { NextRequest, NextResponse } from "next/server";
import { approveRoutedAssistanceForDashboard, rejectRoutedAssistanceForDashboard } from "@/lib/resident-routing-service";
import { AgentJoinError } from "@/lib/agent-join-service";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null) as { decision?: unknown } | null;
    if (body?.decision === "approve") {
      return NextResponse.json({ assignment: await approveRoutedAssistanceForDashboard(id) });
    }
    if (body?.decision === "reject") {
      return NextResponse.json({ dispatch: await rejectRoutedAssistanceForDashboard(id) });
    }
    return NextResponse.json({ error: 'decision must be "approve" or "reject".' }, { status: 400 });
  } catch (error) {
    if (error instanceof AgentJoinError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const queueError = error as Error & { code?: unknown; status?: unknown };
    if (error instanceof Error && typeof queueError.code === "string" && typeof queueError.status === "number") {
      return NextResponse.json({ error: error.message, code: queueError.code }, { status: queueError.status });
    }
    return NextResponse.json({ error: "Could not decide this assistance request." }, { status: 500 });
  }
}
