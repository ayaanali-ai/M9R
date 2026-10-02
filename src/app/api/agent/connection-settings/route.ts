import { NextRequest, NextResponse } from "next/server";
import { readHumanRunSettings, saveHumanRunSettings } from "@/lib/agent-run-settings-service";
import { handleAgentError } from "../_shared";

export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("connectionId");
    if (!id) return NextResponse.json({ error: "Connection id required." }, { status: 400 });
    return NextResponse.json(await readHumanRunSettings(id, req.nextUrl.searchParams.get("conversationId")));
  } catch (error) { return handleAgentError(error); }
}
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.connectionId !== "string" || (body.conversationId !== undefined && typeof body.conversationId !== "string")) return NextResponse.json({ error: "Invalid connection or channel id." }, { status: 400 });
    return NextResponse.json(await saveHumanRunSettings(body.connectionId, body, body.conversationId, body.inherit === true));
  } catch (error) { return handleAgentError(error); }
}
