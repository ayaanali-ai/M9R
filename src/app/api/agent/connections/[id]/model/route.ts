import { NextRequest, NextResponse } from "next/server";
import { setAgentConnectionModel } from "@/lib/agent-join-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

// PATCH /api/agent/connections/[id]/model — set (or clear, with model: null)
// the model override for one connected agent. Cookie-authenticated only;
// setAgentConnectionModel's RLS-scoped lookup is the ownership proof.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { model?: unknown };
    if (body.model !== null && typeof body.model !== "string") {
      return NextResponse.json({ error: "model must be a string or null." }, { status: 400 });
    }
    const result = await setAgentConnectionModel(id, body.model);
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}
