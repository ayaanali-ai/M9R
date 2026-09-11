/**
 * Untrusted model plan output — schema + runtime validation (Phase 5B §4).
 * ----------------------------------------------------------------------------
 * `RawModelPlanOutput` is the ONLY shape a model call is ever allowed to
 * produce. It is deliberately NOT `MissionPlanProposal` — it carries local,
 * model-chosen ids (never real `ParticipantId`/`AssignmentId`/`PlanId`
 * values), no `provider` field at all (provider assignment is always
 * computed from `requiredCapabilities` by `resolveProviderForCapabilities`,
 * mission-planner.ts — a model can never just assert a provider string),
 * and no `status`/`id`/`version` fields (those are Plan-lifecycle concepts
 * this module has no authority over).
 *
 * No existing schema/validation library was found in this repository
 * (checked again for Phase 5B: no zod/ajv/yup/joi/valibot/superstruct/io-ts
 * in package.json) — consistent with Phase 4D Part 3's finding, so this
 * follows the SAME hand-written discriminated-union pattern
 * `mission-protocol-schema.ts` already established, rather than
 * introducing a new dependency or a new validation style.
 *
 * Every schema here is a CLOSED allow-list of keys, exactly like
 * `mission-protocol-schema.ts` — an unrecognized field (e.g. a fabricated
 * `preApproved: true`, or a `provider: "codex"` a model tried to assert
 * directly) is rejected outright, never silently ignored.
 */

import { PROCEDURE_TEMPLATE_IDS, type ProcedureTemplateId } from "./mission-planner-templates";
import { PARTICIPANT_ROLES, ASSIGNMENT_APPROVAL_POLICIES, PLANNER_OPERATING_MODES, type ParticipantRole, type AssignmentApprovalPolicy, type PlannerOperatingMode } from "./mission-domain";
import { canonicalizeRepoPath } from "./mission-path-containment";

export const MODEL_PLAN_OUTPUT_SCHEMA_VERSION = "oathlock.model-plan-output.v1" as const;

/**
 * Integer schema-version pin for `mission_planning_replayable_responses.
 * schema_version` (migration `20260727030000_mission_planning_diagnostics.
 * sql`) — that column is `integer not null`, distinct from the string
 * `MODEL_PLAN_OUTPUT_SCHEMA_VERSION` tag above (which identifies the
 * RawModelPlanOutput wire shape, not a row-storage version). Bump this only
 * when the replayable-response row shape itself changes in a way a stored
 * replay executor needs to distinguish.
 */
export const PLANNING_MODEL_PLAN_SCHEMA_VERSION = 1 as const;

/** Hard caps — "unbounded recursion"/"invalid participant counts" fail closed at the schema layer, before normalization ever walks the structure. */
export const MAX_MODEL_PARTICIPANTS = 8;
export const MAX_MODEL_ASSIGNMENTS = 16;
export const MAX_MODEL_TOPOLOGY_EDGES = 32;
export const MAX_MODEL_STRING_ARRAY_LENGTH = 32;

export interface RawModelParticipant {
  participantId: string;
  role: string;
  requiredCapabilities: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  rationale: string;
}

export interface RawModelAssignment {
  assignmentId: string;
  assigneeId: string | null;
  objective: string;
  allowedPaths: string[];
  prohibitedPaths: string[];
  dependencies: string[];
  requiredEvidence: string[];
  approvalPolicy: string;
  maxDurationMs: number | null;
  maxEstimatedTokens: number | null;
  dispatchEligibilityConditions: string[];
  completionCriteria: string[];
}

export interface RawModelCollaborationEdge {
  from: string;
  to: string;
  kind: string;
}

export interface RawModelPlanOutput {
  schemaVersion: string;
  interpretedObjective: string;
  procedureTemplate: string;
  operatingMode: string;
  participants: RawModelParticipant[];
  assignments: RawModelAssignment[];
  collaborationTopology: RawModelCollaborationEdge[];
  evidenceRequirements: string[];
  approvalGates: string[];
  executionLimits: { maxDurationMs: number | null; maxEstimatedTokens: number | null };
  assumptions: string[];
  unresolvedQuestions: string[];
  warnings: string[];
  rationale: string;
}

export type ModelPlanSchemaErrorCode =
  | "malformed_json"
  | "unsupported_schema_version"
  | "payload_not_an_object"
  | "unknown_field"
  | "missing_required_field"
  | "wrong_type"
  | "invalid_enum_value"
  | "malformed_id"
  | "malformed_array"
  | "duplicate_participant_id"
  | "duplicate_assignment_id"
  | "missing_reference"
  | "dependency_cycle"
  | "malformed_path"
  | "unsupported_template"
  | "array_too_large"
  | "mission_authority_expansion";

export interface ModelPlanSchemaError {
  code: ModelPlanSchemaErrorCode;
  field?: string;
  detail: string;
}

export type ModelPlanSchemaResult = { ok: true; value: RawModelPlanOutput } | { ok: false; error: ModelPlanSchemaError };

function err(code: ModelPlanSchemaErrorCode, detail: string, field?: string): ModelPlanSchemaResult {
  return { ok: false, error: { code, field, detail } };
}

function isStringArray(v: unknown, max = MAX_MODEL_STRING_ARRAY_LENGTH): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const PARTICIPANT_ALLOWED_KEYS = ["participantId", "role", "requiredCapabilities", "allowedPaths", "prohibitedPaths", "rationale"];
const ASSIGNMENT_ALLOWED_KEYS = ["assignmentId", "assigneeId", "objective", "allowedPaths", "prohibitedPaths", "dependencies", "requiredEvidence", "approvalPolicy", "maxDurationMs", "maxEstimatedTokens", "dispatchEligibilityConditions", "completionCriteria"];
const EDGE_ALLOWED_KEYS = ["from", "to", "kind"];
const TOP_LEVEL_ALLOWED_KEYS = [
  "schemaVersion",
  "interpretedObjective",
  "procedureTemplate",
  "operatingMode",
  "participants",
  "assignments",
  "collaborationTopology",
  "evidenceRequirements",
  "approvalGates",
  "executionLimits",
  "assumptions",
  "unresolvedQuestions",
  "warnings",
  "rationale",
];

function checkUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): ModelPlanSchemaResult | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return err("unknown_field", `"${key}" is not a recognized field in ${where} — an unrecognized field is never silently accepted (it could smuggle authority, e.g. a fabricated "provider" or "preApproved").`, key);
  }
  return null;
}

function validPath(path: string): boolean {
  return canonicalizeRepoPath(path).ok;
}

/**
 * Parses and validates raw, untrusted model output text/JSON. Returns a
 * typed error for every case item §4/§20 lists — malformed JSON, unknown
 * schema version, unknown fields, invalid enums, malformed ids, duplicate
 * ids, missing references, dependency cycles, malformed paths, unsupported
 * templates, and array-size caps. Never parses authoritative fields out of
 * free-form prose — every field is read by exact key, never regex-scraped
 * from `rationale`/`assumptions` text.
 */
export function validateRawModelPlanOutput(rawText: string): ModelPlanSchemaResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return err("malformed_json", "model output was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return err("payload_not_an_object", "model output must be a JSON object.");
  const obj = parsed as Record<string, unknown>;

  const unknownTop = checkUnknownKeys(obj, TOP_LEVEL_ALLOWED_KEYS, "the top-level model plan output");
  if (unknownTop) return unknownTop;

  if (obj.schemaVersion !== MODEL_PLAN_OUTPUT_SCHEMA_VERSION) {
    return err("unsupported_schema_version", `expected schemaVersion "${MODEL_PLAN_OUTPUT_SCHEMA_VERSION}", got "${String(obj.schemaVersion)}".`, "schemaVersion");
  }
  if (!isNonEmptyString(obj.interpretedObjective)) return err("missing_required_field", "interpretedObjective is required and must be a non-empty string.", "interpretedObjective");
  if (typeof obj.procedureTemplate !== "string" || !(PROCEDURE_TEMPLATE_IDS as readonly string[]).includes(obj.procedureTemplate)) {
    return err("unsupported_template", `"${String(obj.procedureTemplate)}" is not a supported procedure template.`, "procedureTemplate");
  }
  if (typeof obj.operatingMode !== "string" || !(PLANNER_OPERATING_MODES as readonly string[]).includes(obj.operatingMode)) {
    return err("invalid_enum_value", `"${String(obj.operatingMode)}" is not a supported operating mode.`, "operatingMode");
  }
  if (!Array.isArray(obj.participants) || obj.participants.length === 0 || obj.participants.length > MAX_MODEL_PARTICIPANTS) {
    return err("array_too_large", `participants must be a non-empty array of at most ${MAX_MODEL_PARTICIPANTS}.`, "participants");
  }
  if (!Array.isArray(obj.assignments) || obj.assignments.length === 0 || obj.assignments.length > MAX_MODEL_ASSIGNMENTS) {
    return err("array_too_large", `assignments must be a non-empty array of at most ${MAX_MODEL_ASSIGNMENTS}.`, "assignments");
  }
  if (!Array.isArray(obj.collaborationTopology) || obj.collaborationTopology.length > MAX_MODEL_TOPOLOGY_EDGES) {
    return err("array_too_large", `collaborationTopology must be an array of at most ${MAX_MODEL_TOPOLOGY_EDGES}.`, "collaborationTopology");
  }

  const participantIds = new Set<string>();
  for (const [i, raw] of (obj.participants as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("payload_not_an_object", `participants[${i}] must be an object.`);
    const p = raw as Record<string, unknown>;
    const unknownP = checkUnknownKeys(p, PARTICIPANT_ALLOWED_KEYS, `participants[${i}]`);
    if (unknownP) return unknownP;
    if (!isNonEmptyString(p.participantId)) return err("malformed_id", `participants[${i}].participantId must be a non-empty string.`, "participantId");
    if (participantIds.has(p.participantId)) return err("duplicate_participant_id", `duplicate participantId "${p.participantId}".`, "participantId");
    participantIds.add(p.participantId);
    if (typeof p.role !== "string" || !(PARTICIPANT_ROLES as readonly string[]).includes(p.role)) return err("invalid_enum_value", `"${String(p.role)}" is not a recognized participant role.`, "role");
    if (!isStringArray(p.requiredCapabilities)) return err("malformed_array", `participants[${i}].requiredCapabilities must be a string array.`, "requiredCapabilities");
    if (!isStringArray(p.allowedPaths)) return err("malformed_array", `participants[${i}].allowedPaths must be a string array.`, "allowedPaths");
    if (!isStringArray(p.prohibitedPaths)) return err("malformed_array", `participants[${i}].prohibitedPaths must be a string array.`, "prohibitedPaths");
    for (const path of [...(p.allowedPaths as string[]), ...(p.prohibitedPaths as string[])]) {
      if (!validPath(path)) return err("malformed_path", `"${path}" is not a valid repo-relative path.`, "allowedPaths/prohibitedPaths");
    }
    if (typeof p.rationale !== "string") return err("wrong_type", `participants[${i}].rationale must be a string.`, "rationale");
  }

  const assignmentIds = new Set<string>();
  for (const [i, raw] of (obj.assignments as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("payload_not_an_object", `assignments[${i}] must be an object.`);
    const a = raw as Record<string, unknown>;
    const unknownA = checkUnknownKeys(a, ASSIGNMENT_ALLOWED_KEYS, `assignments[${i}]`);
    if (unknownA) return unknownA;
    if (!isNonEmptyString(a.assignmentId)) return err("malformed_id", `assignments[${i}].assignmentId must be a non-empty string.`, "assignmentId");
    if (assignmentIds.has(a.assignmentId)) return err("duplicate_assignment_id", `duplicate assignmentId "${a.assignmentId}".`, "assignmentId");
    assignmentIds.add(a.assignmentId);
    if (a.assigneeId !== null && !isNonEmptyString(a.assigneeId)) return err("wrong_type", `assignments[${i}].assigneeId must be a non-empty string or null.`, "assigneeId");
    if (!isNonEmptyString(a.objective)) return err("missing_required_field", `assignments[${i}].objective is required.`, "objective");
    if (!isStringArray(a.allowedPaths) || !isStringArray(a.prohibitedPaths)) return err("malformed_array", `assignments[${i}] path arrays must be string arrays.`, "allowedPaths/prohibitedPaths");
    for (const path of [...(a.allowedPaths as string[]), ...(a.prohibitedPaths as string[])]) {
      if (!validPath(path)) return err("malformed_path", `"${path}" is not a valid repo-relative path.`, "allowedPaths/prohibitedPaths");
    }
    if (!isStringArray(a.dependencies)) return err("malformed_array", `assignments[${i}].dependencies must be a string array.`, "dependencies");
    if (!isStringArray(a.requiredEvidence)) return err("malformed_array", `assignments[${i}].requiredEvidence must be a string array.`, "requiredEvidence");
    if (typeof a.approvalPolicy !== "string" || !(ASSIGNMENT_APPROVAL_POLICIES as readonly string[]).includes(a.approvalPolicy)) {
      return err("invalid_enum_value", `"${String(a.approvalPolicy)}" is not a recognized approvalPolicy.`, "approvalPolicy");
    }
    if (a.maxDurationMs !== null && typeof a.maxDurationMs !== "number") return err("wrong_type", `assignments[${i}].maxDurationMs must be a number or null.`, "maxDurationMs");
    if (a.maxEstimatedTokens !== null && typeof a.maxEstimatedTokens !== "number") return err("wrong_type", `assignments[${i}].maxEstimatedTokens must be a number or null.`, "maxEstimatedTokens");
    if (!isStringArray(a.dispatchEligibilityConditions) || !isStringArray(a.completionCriteria)) return err("malformed_array", `assignments[${i}] condition arrays must be string arrays.`, "dispatchEligibilityConditions/completionCriteria");
  }

  // ---- cross-references: assignee/dependency ids must exist ---------------
  for (const [i, raw] of (obj.assignments as Record<string, unknown>[]).entries()) {
    if (raw.assigneeId !== null && !participantIds.has(raw.assigneeId as string)) return err("missing_reference", `assignments[${i}].assigneeId "${raw.assigneeId}" does not reference a proposed participant.`, "assigneeId");
    for (const dep of raw.dependencies as string[]) {
      if (!assignmentIds.has(dep)) return err("missing_reference", `assignments[${i}] depends on unknown assignmentId "${dep}".`, "dependencies");
    }
  }

  // ---- dependency cycle (Kahn's algorithm, same discipline as mission-planner-validator.ts) ----
  const assignmentsArr = obj.assignments as RawModelAssignment[];
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of assignmentsArr) inDegree.set(a.assignmentId, 0);
  for (const a of assignmentsArr) {
    for (const dep of a.dependencies) {
      inDegree.set(a.assignmentId, (inDegree.get(a.assignmentId) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), a.assignmentId]);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      if (inDegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  if (visited.size < assignmentIds.size) return err("dependency_cycle", "the assignment dependency graph is cyclic.");

  // ---- collaboration topology -------------------------------------------------
  for (const [i, raw] of (obj.collaborationTopology as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("payload_not_an_object", `collaborationTopology[${i}] must be an object.`);
    const e = raw as Record<string, unknown>;
    const unknownE = checkUnknownKeys(e, EDGE_ALLOWED_KEYS, `collaborationTopology[${i}]`);
    if (unknownE) return unknownE;
    if (!isNonEmptyString(e.from) || !assignmentIds.has(e.from)) return err("missing_reference", `collaborationTopology[${i}].from does not reference a proposed assignment.`, "from");
    if (!isNonEmptyString(e.to) || !assignmentIds.has(e.to)) return err("missing_reference", `collaborationTopology[${i}].to does not reference a proposed assignment.`, "to");
    if (e.kind !== "review" && e.kind !== "delegation" && e.kind !== "dependency") return err("invalid_enum_value", `"${String(e.kind)}" is not a recognized collaboration edge kind.`, "kind");
  }

  if (!isStringArray(obj.evidenceRequirements) || !isStringArray(obj.approvalGates) || !isStringArray(obj.assumptions) || !isStringArray(obj.unresolvedQuestions) || !isStringArray(obj.warnings)) {
    return err("malformed_array", "one of evidenceRequirements/approvalGates/assumptions/unresolvedQuestions/warnings is not a valid string array.");
  }
  if (typeof obj.rationale !== "string") return err("wrong_type", "rationale must be a string.", "rationale");

  if (typeof obj.executionLimits !== "object" || obj.executionLimits === null || Array.isArray(obj.executionLimits)) return err("payload_not_an_object", "executionLimits must be an object.");
  const limits = obj.executionLimits as Record<string, unknown>;
  const unknownLimits = checkUnknownKeys(limits, ["maxDurationMs", "maxEstimatedTokens"], "executionLimits");
  if (unknownLimits) return unknownLimits;
  if (limits.maxDurationMs !== null && typeof limits.maxDurationMs !== "number") return err("wrong_type", "executionLimits.maxDurationMs must be a number or null.", "executionLimits.maxDurationMs");
  if (limits.maxEstimatedTokens !== null && typeof limits.maxEstimatedTokens !== "number") return err("wrong_type", "executionLimits.maxEstimatedTokens must be a number or null.", "executionLimits.maxEstimatedTokens");

  return {
    ok: true,
    value: {
      schemaVersion: obj.schemaVersion as string,
      interpretedObjective: obj.interpretedObjective as string,
      procedureTemplate: obj.procedureTemplate as ProcedureTemplateId,
      operatingMode: obj.operatingMode as PlannerOperatingMode,
      participants: obj.participants as RawModelParticipant[],
      assignments: assignmentsArr,
      collaborationTopology: obj.collaborationTopology as RawModelCollaborationEdge[],
      evidenceRequirements: obj.evidenceRequirements as string[],
      approvalGates: obj.approvalGates as string[],
      executionLimits: { maxDurationMs: (limits.maxDurationMs as number | null) ?? null, maxEstimatedTokens: (limits.maxEstimatedTokens as number | null) ?? null },
      assumptions: obj.assumptions as string[],
      unresolvedQuestions: obj.unresolvedQuestions as string[],
      warnings: obj.warnings as string[],
      rationale: obj.rationale as string,
    },
  };
}

export type { ParticipantRole, AssignmentApprovalPolicy, PlannerOperatingMode, ProcedureTemplateId };
