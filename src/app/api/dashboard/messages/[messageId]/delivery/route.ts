import { NextResponse } from "next/server";
import { dashboardWorkspaceContext } from "@/lib/dashboard-workspace-context";
import { getDashboardMessageDelivery } from "@/lib/delivery-service";
import { AgentJoinError } from "@/lib/agent-join-service";

export async function GET(_request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const context = await dashboardWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { messageId } = await params;
    return NextResponse.json(await getDashboardMessageDelivery(context.workspaceId, context.userId, messageId), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof AgentJoinError ? error.status : 500;
    return NextResponse.json({ error: status === 404 ? "Message was not found." : "Could not load delivery." }, { status });
  }
}
