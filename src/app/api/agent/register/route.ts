import { NextRequest, NextResponse } from "next/server";
import { validateRegisterInput } from "@/lib/agent-join";
import { registerClaim, AgentJoinError } from "@/lib/agent-join-service";
import { resolveBaseUrl, handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/register — an agent requests a pending workspace connection.
//
// Validates + sanitizes the registration (consent_mode must be human_required),
// creates a one-time claim, and returns the claim_url (for the human) plus a
// secret setup_code (for the agent to poll status). No connection or token is
// created here — that only happens after a human approves the claim.
// ---------------------------------------------------------------------------

export const maxDuration = 15;

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json(
        { error: "Content-Type must be application/json" },
        { status: 415 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const validation = validateRegisterInput(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const result = await registerClaim(validation.value, resolveBaseUrl(req));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AgentJoinError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return handleAgentError(err);
  }
}
