import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { createGoal, listGoals } from "@/lib/goal/goal-service";
import { handleAgentError } from "../_shared";

export const dynamic = "force-dynamic";

/** POST creates a durable provider-neutral Goal; GET lists Goals in the token workspace. */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    return NextResponse.json({ goal: await createGoal(agent, body) }, { status: 201 });
  } catch (error) {
    return handleAgentError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? "20");
    return NextResponse.json({ goals: await listGoals(agent, rawLimit) });
  } catch (error) {
    return handleAgentError(error);
  }
}
