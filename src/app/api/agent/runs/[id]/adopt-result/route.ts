import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { recordResultAdoption } from "@/lib/result-adoption-service";
import { handleAgentError } from "../../../_shared";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    const agent = await authenticateAgent(token);
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { id: runId } = await params;
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const launchGrantId = typeof body?.launch_grant_id === "string" ? body.launch_grant_id : "";
    if (!launchGrantId) return NextResponse.json({ error: "launch_grant_id is required." }, { status: 400 });
    const result = await recordResultAdoption(agent, runId, launchGrantId, {
      decision: body?.decision,
      rationale: body?.rationale,
      planEffect: body?.plan_effect,
    });
    return NextResponse.json({ adoption: result }, { status: 201 });
  } catch (error) { return handleAgentError(error); }
}
