import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { startConversation, listOpenConversationsForAgent, consumeHandoffsForAgent } from "@/lib/conversation-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/conversations — start a real multi-turn conversation with
// one or more other connections in the same workspace.
// GET  /api/agent/conversations — list open conversations this connection
// participates in (the Agent Inbox checks this alongside human instructions).
// Bearer-token only.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const topic = typeof body.topic === "string" ? body.topic : "";
    const participantConnectionIds = Array.isArray(body.participant_connection_ids)
      ? body.participant_connection_ids.filter((id): id is string => typeof id === "string")
      : [];

    const conversation = await startConversation(agent, { topic, participantConnectionIds });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    const conversations = await listOpenConversationsForAgent(agent);
    // Same checkpoint call, not a separate command to remember: a handoff
    // addressed to this connection auto-starts a run on it right here.
    const spawnedRuns = await consumeHandoffsForAgent(agent);
    return NextResponse.json({ conversations, spawned_runs: spawnedRuns });
  } catch (err) {
    return handleAgentError(err);
  }
}
