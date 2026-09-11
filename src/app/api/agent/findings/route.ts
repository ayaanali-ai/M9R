import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requireOwnRun } from "@/lib/agent-run-service";
import { publishFinding, listFindingsForUser, countAdoptions, attachFindingAnnouncementMessage } from "@/lib/finding-service";
import type { FindingEvidenceLevel } from "@/lib/finding";
import { findOrCreateAgentDmForBearer, sendConversationMessage } from "@/lib/conversation-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET  /api/agent/findings — dashboard read (cookie, RLS-scoped).
// POST /api/agent/findings — publish a Finding (Bearer, agent).
//
// A published Finding starts in review_state "observed" — it is NOT visible
// to other runs until an Operator reviews it (see
// /api/agent/findings/[id]/review). This route never sets review_state to
// "available" itself.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET() {
  try {
    const findings = await listFindingsForUser();
    // Adoption counts are joined server-side so the dashboard never does an
    // N+1 fetch per finding (see UI_BUILD_PLAN.md, Findings Ledger).
    const adoptions = await Promise.all(findings.map((f) => countAdoptions(f.id)));
    return NextResponse.json({
      findings: findings.map((f, i) => ({ ...f, adoptions: adoptions[i] })),
    });
  } catch (err) {
    return handleAgentError(err);
  }
}

interface FindingBody {
  run_id?: unknown;
  title?: unknown;
  applicable_environment?: unknown;
  observed_behavior?: unknown;
  evidence_level?: unknown;
  suggested_response?: unknown;
  known_limitations?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);

    const raw = (await req.json().catch(() => null)) as FindingBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);
    const runId = typeof raw.run_id === "string" ? raw.run_id : "";
    if (!runId) return jsonError("run_id is required.", 400);
    await requireOwnRun(agent, runId);

    const result = await publishFinding({
      workspaceId: agent.workspaceId,
      originatingRunId: runId,
      originatingSender: agent.agentKind ?? "agent",
      title: typeof raw.title === "string" ? raw.title : "",
      applicableEnvironment: typeof raw.applicable_environment === "string" ? raw.applicable_environment : "",
      observedBehavior: typeof raw.observed_behavior === "string" ? raw.observed_behavior : "",
      evidenceLevel: (typeof raw.evidence_level === "string" ? raw.evidence_level : "inferred") as FindingEvidenceLevel,
      suggestedResponse: typeof raw.suggested_response === "string" ? raw.suggested_response : "",
      knownLimitations: Array.isArray(raw.known_limitations)
        ? raw.known_limitations.filter((l): l is string => typeof l === "string")
        : [],
    });
    if (!result.ok) return jsonError(result.errors.join(" ") || "Could not publish the finding.", 400);
    // Announce in the reporting agent's DM, same pattern as the run-start
    // approval card, so this shows inline in the message feed instead of
    // only existing in the Approval Center drawer. Additive -- must never
    // fail the finding publish itself.
    if (result.id) {
      try {
        const conversationId = await findOrCreateAgentDmForBearer(agent);
        const message = await sendConversationMessage(agent, {
          conversationId,
          recipientConnectionId: null,
          kind: "notice",
          body: `Publishing a finding for human review: ${(typeof raw.title === "string" ? raw.title : "").slice(0, 300)}`,
          parentMessageId: null,
          idempotencyKey: `finding-announce-message:${result.id}`,
          relatedRunId: runId,
        });
        await attachFindingAnnouncementMessage(result.id, agent.workspaceId, message.id);
      } catch {
        // The Findings drawer/page remains the source of truth; the inline
        // chat card is additive and must never block a finding publish.
      }
    }
    return NextResponse.json({ finding_id: result.id, review_state: "observed" });
  } catch (err) {
    return handleAgentError(err);
  }
}
