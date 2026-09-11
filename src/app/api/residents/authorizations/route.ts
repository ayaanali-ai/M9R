import { NextRequest, NextResponse } from "next/server";
import { createResidentAuthorization, listResidentAuthorizations } from "@/lib/resident-authorization-service";
import { handleAgentError } from "../../agent/_shared";

export async function GET() {
  try { return NextResponse.json({ ok: true, ...(await listResidentAuthorizations()) }); }
  catch (error) { return handleAgentError(error); }
}

export async function POST(req: NextRequest) {
  try { return NextResponse.json({ ok: true, authorization: await createResidentAuthorization(await req.json()) }); }
  catch (error) { return handleAgentError(error); }
}
