import { NextResponse } from "next/server";
import { PersonaPackError } from "@/lib/mission/persona-pack-schema";
import { WorkflowDefinitionError } from "@/lib/mission/mission-workflow-schema";
import { handleAgentError } from "../agent/_shared";

/**
 * Shared error mapper for /api/dashboard/* routes. Every dashboard-service
 * function (conversation-service.ts) already throws AgentJoinError, so this
 * delegates to the exact same handler /api/agent/* already uses rather than
 * reimplementing it -- the two route families share one backing error
 * taxonomy, they just weren't sharing the one place that reads it. The other
 * two branches are validation-only errors with no status of their own
 * (always 400), previously handled ad hoc per-route.
 */
export function handleDashboardApiError(err: unknown): NextResponse {
  if (err instanceof PersonaPackError) {
    return NextResponse.json({ error: err.message, code: "invalid_persona_pack" }, { status: 400 });
  }
  if (err instanceof WorkflowDefinitionError) {
    return NextResponse.json({ error: err.message, code: "invalid_workflow_definition" }, { status: 400 });
  }
  return handleAgentError(err);
}
