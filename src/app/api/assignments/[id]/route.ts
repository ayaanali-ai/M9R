import { NextRequest, NextResponse } from "next/server";
import { cancelAssignmentForDashboard } from "@/lib/assignment-service";
import { handleAgentError } from "../../agent/_shared";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.decision !== "cancel") return NextResponse.json({ error: "Only cancel is available to the owner." }, { status: 400 });
    const { id } = await params;
    return NextResponse.json({ assignment: await cancelAssignmentForDashboard(id) });
  } catch (error) {
    return handleAgentError(error);
  }
}
