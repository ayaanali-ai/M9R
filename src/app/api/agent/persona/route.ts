import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { getAssignedPersona } from "@/lib/mission/persona-pack-store";
import { handleAgentError } from "../_shared";

/** Named risk from item #16 Part A: persona text lands in the instruction position of a real agent's prompt, so it is capped here -- the one choke point every consumer goes through -- rather than trusted from whatever a workspace author saved. */
const PERSONA_PROMPT_MAX_WORDS = 300;

function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text.trim() : words.slice(0, maxWords).join(" ");
}

// ---------------------------------------------------------------------------
// GET /api/agent/persona — this connection's assigned persona prompt text,
// if any. Item #16 Part A: the read path bridge-runtime.ts polls (same
// cadence as /api/agent/rules) to resolve `getAssignedPersona`, which
// existed but was never called anywhere on the turn path before this.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!agent.agentKind) return NextResponse.json({ prompt: null });

    const persona = await getAssignedPersona(agent.workspaceId, agent.agentKind);
    if (!persona?.prompt?.trim()) return NextResponse.json({ prompt: null });

    return NextResponse.json({ prompt: capWords(persona.prompt, PERSONA_PROMPT_MAX_WORDS) });
  } catch (err) {
    return handleAgentError(err);
  }
}
