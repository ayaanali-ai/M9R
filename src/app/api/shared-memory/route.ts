import { NextRequest, NextResponse } from "next/server";
import { mutateSharedMemory, readHumanSharedMemory, saveSharedMemory } from "@/lib/shared-memory-service";
import { handleAgentError } from "../agent/_shared";

export async function GET(req: NextRequest) {
  try { return NextResponse.json(await readHumanSharedMemory(req.nextUrl.searchParams.get("conversationId")), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return handleAgentError(error); }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid memory note." }, { status: 400 });
    return NextResponse.json(await saveSharedMemory(body));
  }
  catch (error) { return handleAgentError(error); }
}
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.id !== "string" || !["approve", "delete"].includes(body.action)) return NextResponse.json({ error: "Invalid memory action." }, { status: 400 });
    return NextResponse.json(await mutateSharedMemory(body.id, body.action));
  } catch (error) { return handleAgentError(error); }
}
