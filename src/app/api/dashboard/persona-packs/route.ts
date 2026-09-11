import { NextRequest, NextResponse } from "next/server";
import { createDashboardPersonaPack, listDashboardPersonaPacks, deleteDashboardPersonaPack } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../_shared";

export async function GET() {
  try {
    const packs = await listDashboardPersonaPacks();
    return NextResponse.json({ packs });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "A JSON pack manifest is required." }, { status: 400 });
  try {
    const pack = await createDashboardPersonaPack(body);
    return NextResponse.json({ pack }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    await deleteDashboardPersonaPack(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
