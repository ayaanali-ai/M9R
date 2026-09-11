import { NextRequest, NextResponse } from "next/server";
import { baselineRulesResponse, OATHLOCK_OPERATING_INSTRUCTIONS } from "@/lib/agent-join";
import {
  authenticateAgent,
  bearerFrom,
  listActiveRulesForAgent,
} from "@/lib/agent-join-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/rules — return the connected workspace's active rules.
//
// Requires a Bearer agent token. If the workspace has evidence-backed active
// rules, returns them. Otherwise returns honest baseline mode — it NEVER
// invents starter behavior rules. OathLock operating instructions (e.g. "do not
// upload secrets") are always included, clearly labeled as operating guidance
// rather than workspace behavior rules.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }
    if (!agent.scopes.includes("rules:read")) {
      return NextResponse.json({ error: "Token lacks rules:read scope." }, { status: 403 });
    }

    const rules = await listActiveRulesForAgent(agent);

    if (rules.length === 0) {
      return NextResponse.json(baselineRulesResponse());
    }

    return NextResponse.json({
      mode: "active",
      message: "Evidence-backed workspace rules are active for this workspace.",
      rules,
      operating_instructions: [...OATHLOCK_OPERATING_INSTRUCTIONS],
    });
  } catch (err) {
    return handleAgentError(err);
  }
}
