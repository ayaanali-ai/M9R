import { NextRequest, NextResponse } from "next/server";
import { createDashboardDirectMessage } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../_shared";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { connectionId?: unknown } | null;
  if (typeof body?.connectionId !== "string") return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
  try {
    return NextResponse.json({ conversation: await createDashboardDirectMessage(body.connectionId) }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
