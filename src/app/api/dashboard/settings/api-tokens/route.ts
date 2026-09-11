import { NextRequest, NextResponse } from "next/server";
import { listUserApiTokens, createUserApiToken, revokeUserApiToken, UserApiTokenError } from "@/lib/user-api-token-service";

function handleError(error: unknown) {
  if (error instanceof UserApiTokenError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}

export async function GET() {
  try {
    const tokens = await listUserApiTokens();
    return NextResponse.json({ tokens });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { label?: unknown } | null;
  const label = typeof body?.label === "string" ? body.label : "API token";
  try {
    const created = await createUserApiToken(label);
    return NextResponse.json({ token: created }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    await revokeUserApiToken(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}
