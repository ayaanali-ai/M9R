import { NextRequest, NextResponse } from "next/server";
import { revokeResidentAuthorization } from "@/lib/resident-authorization-service";
import { handleAgentError } from "../../../agent/_shared";

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; return NextResponse.json({ ok: true, authorization: await revokeResidentAuthorization(id) }); }
  catch (error) { return handleAgentError(error); }
}
