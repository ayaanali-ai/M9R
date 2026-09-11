import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listCompletionReceipts, submitCompletionReceipt } from "@/lib/goal/goal-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json({ receipts: await listCompletionReceipts(agent, goalId) });
  } catch (error) {
    return handleAgentError(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json({ receipt: await submitCompletionReceipt(agent, goalId, await req.json()) }, { status: 201 });
  } catch (error) {
    return handleAgentError(error);
  }
}
