import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { getResidentDiffReview, upsertResidentDiffManifest } from "@/lib/resident-service";
import { handleAgentError } from "../../../../_shared";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization"))); if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { id } = await context.params; return NextResponse.json({ ok: true, ...(await getResidentDiffReview(agent, id, req.nextUrl.searchParams.get("instance_key") ?? "")) });
  } catch (error) { return handleAgentError(error); }
}
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization"))); if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { id } = await context.params; const body = await req.json() as Record<string, unknown>; return NextResponse.json({ ok: true, ...(await upsertResidentDiffManifest(agent, id, String(body.instanceKey ?? ""), body)) });
  } catch (error) { return handleAgentError(error); }
}
