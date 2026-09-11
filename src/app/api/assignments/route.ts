import { NextRequest, NextResponse } from "next/server";
import { createAssignmentForDashboard, listAssignmentsForDashboard } from "@/lib/assignment-service";
import { handleAgentError } from "../agent/_shared";

export async function GET() {
  try { return NextResponse.json({ assignments: await listAssignmentsForDashboard() }); }
  catch (error) { return handleAgentError(error); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (typeof body.target_connection_id !== "string") return NextResponse.json({ error: "target_connection_id is required." }, { status: 400 });
    return NextResponse.json({ assignment: await createAssignmentForDashboard(body.target_connection_id, body) }, { status: 201 });
  } catch (error) { return handleAgentError(error); }
}
