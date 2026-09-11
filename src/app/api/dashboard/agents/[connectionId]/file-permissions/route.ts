import { NextRequest, NextResponse } from "next/server";
import { listDeniedFilePatternsForDashboard, addDeniedFilePatternForDashboard, removeDeniedFilePatternForDashboard, FilePermissionsError } from "@/lib/bridge/agent-file-permissions-service";

// #20: human-facing management of one connected agent's file-write DENY
// list -- enforcement already exists at the real ACP tool-call boundary
// (acp-stdio-adapter.ts), this is the missing "let a human actually set
// one" half. GET lists patterns, POST adds one, DELETE removes one (?id=).

function handleError(error: unknown) {
  if (error instanceof FilePermissionsError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  try {
    const patterns = await listDeniedFilePatternsForDashboard(connectionId);
    return NextResponse.json({ patterns });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const body = await request.json().catch(() => null) as { pattern?: unknown } | null;
  if (typeof body?.pattern !== "string" || !body.pattern.trim()) {
    return NextResponse.json({ error: "pattern is required." }, { status: 400 });
  }
  try {
    const created = await addDeniedFilePatternForDashboard(connectionId, body.pattern);
    return NextResponse.json({ pattern: created }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    await removeDeniedFilePatternForDashboard(connectionId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}
