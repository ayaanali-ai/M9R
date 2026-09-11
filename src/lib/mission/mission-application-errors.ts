/**
 * Mission application API — typed error taxonomy.
 * ----------------------------------------------------------------------------
 * One discriminated union covering every way a Mission API call can fail,
 * so a route never has to collapse a domain refusal into a generic 500.
 * Mirrors the `{ok, error}` convention `applyMissionCommand` already uses
 * (mission-command-handler.ts) rather than the legacy /api/agent/* thrown-
 * class convention (`AgentJoinError`) — Mission callers branch on `.code`,
 * they never need a try/catch for a domain refusal.
 */

import type { ApplyCommandError } from "./mission-commands";

export type MissionApiErrorCode =
  | "unauthenticated"
  | "workspace_not_resolved"
  | "human_required"
  | "agent_required"
  | "validation_error"
  | "mission_not_found"
  | "conflict"
  | "backend_not_configured"
  | ApplyCommandError["code"];

export class MissionApiError extends Error {
  readonly code: MissionApiErrorCode;
  readonly status: number;
  readonly correlationId: string | null;
  readonly detail?: Record<string, unknown>;

  constructor(
    message: string,
    code: MissionApiErrorCode,
    status: number,
    options?: { correlationId?: string | null; detail?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "MissionApiError";
    this.code = code;
    this.status = status;
    this.correlationId = options?.correlationId ?? null;
    this.detail = options?.detail;
  }
}

/** HTTP status for each ApplyCommandError.code — used both here and by mapApplyCommandError. */
const APPLY_COMMAND_ERROR_STATUS: Record<string, number> = {
  mission_not_found: 404,
  mission_already_exists: 409,
  version_conflict: 409,
  idempotency_conflict: 409,
  workspace_mismatch: 404, // never 403: existence must not leak across tenants
  invalid_transition: 409,
  invalid_assignment_transition: 409,
  invalid_participant_transition: 409,
  invalid_finding_transition: 409,
  invalid_plan_transition: 409,
  invalid_planning_request_transition: 409,
  no_resume_target: 409,
  mission_terminal: 409,
  unauthorized_command: 403,
  unauthorized_approval: 403,
  unauthorized_plan_approval: 403,
  assignment_not_found: 404,
  participant_not_found: 404,
  finding_not_found: 404,
  plan_not_found: 404,
  question_not_found: 404,
  planning_request_not_found: 404,
  evidence_not_found: 404,
  evidence_already_exists: 409,
  evidence_dispatch_key_mismatch: 409,
};

/** Map a rejected `ApplyCommandResult.error` onto a MissionApiError, preserving its exact code. */
export function fromApplyCommandError(error: ApplyCommandError, correlationId?: string | null): MissionApiError {
  const status = APPLY_COMMAND_ERROR_STATUS[error.code] ?? 422;
  const detail = { ...(error as unknown as Record<string, unknown>) };
  delete detail.code;
  return new MissionApiError(describeApplyCommandError(error), error.code as MissionApiErrorCode, status, {
    correlationId,
    detail,
  });
}

function describeApplyCommandError(error: ApplyCommandError): string {
  switch (error.code) {
    case "mission_not_found":
      return "Mission was not found.";
    case "workspace_mismatch":
      return "Mission was not found.";
    case "version_conflict":
      return "Mission has changed since this request was built; reload and retry.";
    case "idempotency_conflict":
      return "This request id was already used for a different command.";
    case "mission_terminal":
      return "Mission is in a terminal state and cannot be changed.";
    case "unauthorized_command":
    case "unauthorized_approval":
    case "unauthorized_plan_approval":
      return "Actor is not authorized to perform this command.";
    default:
      return `Mission command was refused (${error.code}).`;
  }
}
