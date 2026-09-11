export const GOAL_CONTRACT_VERSION = "m9r.goal.v1" as const;

export const GOAL_STATUSES = [
  "proposed",
  "authorized",
  "planning",
  "executing",
  "waiting",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
  "paused",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_PRINCIPAL_KINDS = [
  "human",
  "organization",
  "personal_agent",
  "workspace_agent",
  "provider_agent",
] as const;

export type GoalPrincipalKind = (typeof GOAL_PRINCIPAL_KINDS)[number];

export const GOAL_AUTONOMY_POLICIES = [
  "observe",
  "human_required",
  "bounded_execute",
  "delegated_action",
  "auto_continue",
] as const;

export type GoalAutonomyPolicy = (typeof GOAL_AUTONOMY_POLICIES)[number];

export interface GoalBudget {
  maxDurationMs: number | null;
  maxEstimatedTokens: number | null;
}

export interface GoalRequest {
  clientRequestId: string;
  principalId: string;
  principalKind: GoalPrincipalKind;
  title: string;
  objective: string;
  successConditions: string[];
  constraints: string[];
  allowedCapabilities: string[];
  providerPreferences: string[];
  autonomyPolicy: GoalAutonomyPolicy;
  budget: GoalBudget;
  deadline: string | null;
  parentGoalId: string | null;
  contextRefs: string[];
}

export interface GoalContract {
  version: typeof GOAL_CONTRACT_VERSION;
  goal: GoalRequest;
}

export interface GoalValidationIssue {
  path: string;
  code: "required" | "type" | "format" | "range" | "unknown_value";
  message: string;
}

export type GoalContractValidation =
  | { ok: true; value: GoalContract }
  | { ok: false; errors: GoalValidationIssue[] };

const MAX_ID_LENGTH = 160;
const MAX_TITLE_LENGTH = 160;
const MAX_OBJECTIVE_LENGTH = 8_000;
const MAX_LIST_LENGTH = 32;
const MAX_LIST_ITEM_LENGTH = 1_000;
const MAX_CONTEXT_REFS = 64;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const SAFE_LIST_ITEM = /^[^\u0000-\u001f\u007f]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: GoalValidationIssue[],
): T | undefined {
  if (typeof value !== "string") {
    errors.push({ path, code: "type", message: "must be a string" });
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    errors.push({
      path,
      code: "unknown_value",
      message: `must be one of: ${allowed.join(", ")}`,
    });
    return undefined;
  }
  return value as T;
}

function readRequiredString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: GoalValidationIssue[],
  options: { id?: boolean } = {},
): string | undefined {
  if (typeof value !== "string") {
    errors.push({ path, code: "required", message: "must be a string" });
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    errors.push({ path, code: "required", message: "must not be empty" });
    return undefined;
  }
  if (normalized.length > maxLength) {
    errors.push({
      path,
      code: "range",
      message: `must be at most ${maxLength} characters`,
    });
    return undefined;
  }
  if (options.id ? !SAFE_ID.test(normalized) : !SAFE_LIST_ITEM.test(normalized)) {
    errors.push({
      path,
      code: "format",
      message: options.id
        ? "contains unsupported characters"
        : "contains control characters",
    });
    return undefined;
  }
  return normalized;
}

function readOptionalString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: GoalValidationIssue[],
): string | null | undefined {
  if (value === null || value === undefined) return null;
  return readRequiredString(value, path, maxLength, errors);
}

function readStringList(
  value: unknown,
  path: string,
  maxItems: number,
  errors: GoalValidationIssue[],
  minItems = 0,
): string[] {
  if (!Array.isArray(value)) {
    errors.push({ path, code: "type", message: "must be an array" });
    return [];
  }
  if (value.length > maxItems) {
    errors.push({
      path,
      code: "range",
      message: `must contain at most ${maxItems} items`,
    });
  }
  if (value.length < minItems) {
    errors.push({
      path,
      code: "range",
      message: `must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`,
    });
  }

  return value.slice(0, maxItems).flatMap((item, index) => {
    const parsed = readRequiredString(
      item,
      `${path}[${index}]`,
      MAX_LIST_ITEM_LENGTH,
      errors,
    );
    return parsed === undefined ? [] : [parsed];
  });
}

function readBudget(
  value: unknown,
  errors: GoalValidationIssue[],
): GoalBudget {
  if (!isRecord(value)) {
    errors.push({ path: "goal.budget", code: "required", message: "must be an object" });
    return { maxDurationMs: null, maxEstimatedTokens: null };
  }

  const readLimit = (key: keyof GoalBudget): number | null => {
    const item = value[key];
    if (item === null || item === undefined) return null;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1) {
      errors.push({
        path: `goal.budget.${key}`,
        code: "range",
        message: "must be null or a positive safe integer",
      });
      return null;
    }
    return item;
  };

  return {
    maxDurationMs: readLimit("maxDurationMs"),
    maxEstimatedTokens: readLimit("maxEstimatedTokens"),
  };
}

function readDeadline(
  value: unknown,
  errors: GoalValidationIssue[],
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push({
      path: "goal.deadline",
      code: "format",
      message: "must be a valid ISO-8601 date or null",
    });
    return null;
  }
  return new Date(value).toISOString();
}

/**
 * Validates and normalizes the provider-neutral Goal contract.
 *
 * This function deliberately performs no I/O, authorization, model calls, or
 * mission creation. It is safe to use at an ingress boundary before a hosted
 * application decides whether and how to execute a goal.
 */
export function parseGoalContract(input: unknown): GoalContractValidation {
  const errors: GoalValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ path: "$", code: "type", message: "must be an object" }],
    };
  }

  const version = input.version;
  if (version !== GOAL_CONTRACT_VERSION) {
    errors.push({
      path: "version",
      code: "unknown_value",
      message: `must equal ${GOAL_CONTRACT_VERSION}`,
    });
  }

  const rawGoal = input.goal;
  if (!isRecord(rawGoal)) {
    errors.push({ path: "goal", code: "required", message: "must be an object" });
    return { ok: false, errors };
  }

  const clientRequestId = readRequiredString(
    rawGoal.clientRequestId,
    "goal.clientRequestId",
    MAX_ID_LENGTH,
    errors,
    { id: true },
  );
  const principalId = readRequiredString(
    rawGoal.principalId,
    "goal.principalId",
    MAX_ID_LENGTH,
    errors,
    { id: true },
  );
  const principalKind = readEnum(
    rawGoal.principalKind,
    GOAL_PRINCIPAL_KINDS,
    "goal.principalKind",
    errors,
  );
  const title = readRequiredString(rawGoal.title, "goal.title", MAX_TITLE_LENGTH, errors);
  const objective = readRequiredString(
    rawGoal.objective,
    "goal.objective",
    MAX_OBJECTIVE_LENGTH,
    errors,
  );
  const autonomyPolicy = readEnum(
    rawGoal.autonomyPolicy,
    GOAL_AUTONOMY_POLICIES,
    "goal.autonomyPolicy",
    errors,
  );
  const parentGoalId = readOptionalString(
    rawGoal.parentGoalId,
    "goal.parentGoalId",
    MAX_ID_LENGTH,
    errors,
  );

  const normalized: GoalContract = {
    version: GOAL_CONTRACT_VERSION,
    goal: {
      clientRequestId: clientRequestId ?? "",
      principalId: principalId ?? "",
      principalKind: principalKind ?? "human",
      title: title ?? "",
      objective: objective ?? "",
      successConditions: readStringList(
        rawGoal.successConditions,
        "goal.successConditions",
        MAX_LIST_LENGTH,
        errors,
        1,
      ),
      constraints: readStringList(
        rawGoal.constraints,
        "goal.constraints",
        MAX_LIST_LENGTH,
        errors,
      ),
      allowedCapabilities: readStringList(
        rawGoal.allowedCapabilities,
        "goal.allowedCapabilities",
        MAX_LIST_LENGTH,
        errors,
      ),
      providerPreferences: readStringList(
        rawGoal.providerPreferences,
        "goal.providerPreferences",
        MAX_LIST_LENGTH,
        errors,
      ),
      autonomyPolicy: autonomyPolicy ?? "human_required",
      budget: readBudget(rawGoal.budget, errors),
      deadline: readDeadline(rawGoal.deadline, errors),
      parentGoalId: parentGoalId ?? null,
      contextRefs: readStringList(
        rawGoal.contextRefs,
        "goal.contextRefs",
        MAX_CONTEXT_REFS,
        errors,
      ),
    },
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: normalized };
}

const GOAL_STATUS_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  proposed: ["authorized", "cancelled"],
  authorized: ["planning", "paused", "cancelled"],
  planning: ["executing", "waiting", "blocked", "review", "failed", "paused", "cancelled"],
  executing: ["waiting", "blocked", "review", "completed", "failed", "paused", "cancelled"],
  waiting: ["planning", "executing", "blocked", "paused", "cancelled"],
  blocked: ["planning", "waiting", "failed", "paused", "cancelled"],
  review: ["completed", "planning", "blocked", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  paused: ["authorized", "planning", "executing", "cancelled"],
};

/** Returns whether a Goal may move between two lifecycle states. */
export function canTransitionGoalStatus(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_STATUS_TRANSITIONS[from].includes(to);
}

/** Returns a copy so callers cannot mutate the transition table. */
export function goalStatusTransitions(from: GoalStatus): readonly GoalStatus[] {
  return [...GOAL_STATUS_TRANSITIONS[from]];
}
