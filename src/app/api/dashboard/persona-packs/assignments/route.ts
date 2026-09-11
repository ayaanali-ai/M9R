import { NextRequest, NextResponse } from "next/server";
import { assignDashboardPersona, clearDashboardPersonaAssignment } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../_shared";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { agentKind?: unknown; packId?: unknown; personaName?: unknown } | null;
  if (typeof body?.agentKind !== "string" || typeof body.packId !== "string" || typeof body.personaName !== "string") {
    return NextResponse.json({ error: "agentKind, packId, and personaName are required." }, { status: 400 });
  }
  try {
    const persona = await assignDashboardPersona({ agentKind: body.agentKind, packId: body.packId, personaName: body.personaName });
    return NextResponse.json({ persona });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const agentKind = request.nextUrl.searchParams.get("agentKind");
  if (!agentKind) return NextResponse.json({ error: "agentKind is required." }, { status: 400 });
  try {
    await clearDashboardPersonaAssignment(agentKind);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
