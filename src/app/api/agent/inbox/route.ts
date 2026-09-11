import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import {
  agentCanReadInstructions,
  createInstructionForDashboard,
  pullInstructionsForAgent,
} from "@/lib/agent-instruction-channel-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// /api/agent/inbox — Agent Instruction Channel v0.
//
// POST: dashboard queues a short instruction for a selected active connection.
// GET: connected coding agent pulls queued instructions with the CLI.
// Pulling marks instructions as pulled; it never deletes audit history.
// ---------------------------------------------------------------------------

type InboxPostBody = {
  connection_id?: unknown;
  instruction?: unknown;
  message?: unknown;
};

async function readJsonBody(req: NextRequest): Promise<InboxPostBody | NextResponse> {
  try {
    return (await req.json()) as InboxPostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }
    if (!agentCanReadInstructions(agent.scopes)) {
      return NextResponse.json({ error: "Token lacks instructions:read scope." }, { status: 403 });
    }

    const instructions = await pullInstructionsForAgent(agent);
    return NextResponse.json({
      ok: true,
      channel: "Agent inbox",
      message:
        instructions.length > 0
          ? `${instructions.length} instruction(s) pulled from the Agent inbox.`
          : "Agent inbox is empty.",
      instructions,
    });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    if (body instanceof NextResponse) return body;

    const instruction = await createInstructionForDashboard({
      connectionId: body.connection_id,
      instruction: body.instruction ?? body.message,
    });

    return NextResponse.json(
      {
        ok: true,
        channel: "Instruction channel",
        message: "Instruction queued for the Agent inbox.",
        instruction,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleAgentError(err);
  }
}
