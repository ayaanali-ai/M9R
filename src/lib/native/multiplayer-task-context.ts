import { z } from "zod";
import { MAX_ACTIVE_AGENTS } from "./multiplayer-contract";

/**
 * Task-local coordination state. This is deliberately separate from an A2A
 * transport message: a user control changes this state, while an agent
 * message is only one evidence-bearing event inside the task room.
 */

const identifier = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/);

const boundedLabel = z.string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Task labels cannot contain control characters.");

export const taskStateSchema = z.enum([
  "active",
  "paused-owner",
  "waiting-user",
  "waiting-agent",
  "replanning",
  "completed",
  "canceled",
]);

export const taskControlKindSchema = z.enum([
  "continuation",
  "clarification",
  "pause",
  "resume",
  "redirect",
  "cancel",
  "new-task",
]);

export const taskIntentModeSchema = z.enum([
  "explain",
  "prepare",
  "advance",
  "submit",
]);

/** How one action wants to use a surface. This is chosen per action, not per task. */
export const taskDeliveryModeSchema = z.enum([
  "background-semantic",
  "visible-semantic",
  "exclusive-input",
]);

export const taskProgressKindSchema = z.enum([
  "observation",
  "operation-completed",
  "artifact-changed",
  "postcondition-verified",
  "blocker",
]);

export const taskAssignmentSchema = z.object({
  assignmentId: identifier,
  workKey: identifier,
  agentId: identifier,
  planRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["proposed", "claimed", "completed", "released"]),
  summary: boundedLabel,
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const taskProgressWitnessSchema = z.object({
  witnessId: identifier,
  kind: taskProgressKindSchema,
  /** A stable, non-secret fingerprint of the observed task state. */
  stateFingerprint: identifier,
  summary: boundedLabel,
  operationId: identifier.optional(),
  surfaceId: identifier.optional(),
  observationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const taskParticipantSchema = z.object({
  agentId: identifier,
  branchId: identifier,
  provider: boundedLabel,
}).strict();

export const taskObservationSchema = z.object({
  surfaceId: identifier,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  stateFingerprint: identifier,
  observedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const taskArtifactSchema = z.object({
  artifactId: identifier,
  kind: identifier,
  label: boundedLabel,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const taskDecisionSchema = z.object({
  decisionId: identifier,
  question: boundedLabel,
  options: z.array(boundedLabel).max(16).optional(),
  resolved: z.boolean(),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const taskContextSchema = z.object({
  taskId: identifier,
  conversationId: identifier,
  runId: identifier,
  state: taskStateSchema,
  intentMode: taskIntentModeSchema,
  allowAdvance: z.boolean(),
  allowSubmit: z.boolean(),
  planRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  participants: z.array(taskParticipantSchema).min(1).max(MAX_ACTIVE_AGENTS),
  assignments: z.array(taskAssignmentSchema).max(128),
  observations: z.array(taskObservationSchema).max(128),
  artifacts: z.array(taskArtifactSchema).max(128),
  pendingDecisions: z.array(taskDecisionSchema).max(64),
  progress: z.object({
    lastWitness: taskProgressWitnessSchema.optional(),
    noProgressStreak: z.number().int().min(0).max(32),
  }).strict(),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((context, issue) => {
  const agentIds = context.participants.map((participant) => participant.agentId);
  if (new Set(agentIds).size !== agentIds.length) issue.addIssue({ code: "custom", path: ["participants"], message: "Task participants must be unique." });
  const assignmentIds = context.assignments.map((assignment) => assignment.assignmentId);
  if (new Set(assignmentIds).size !== assignmentIds.length) issue.addIssue({ code: "custom", path: ["assignments"], message: "Task assignments must be unique." });
  if (context.updatedAt < context.createdAt) issue.addIssue({ code: "custom", path: ["updatedAt"], message: "Task updatedAt cannot precede createdAt." });
});

export const taskControlSchema = z.object({
  controlId: identifier,
  taskId: identifier,
  kind: taskControlKindSchema,
  summary: boundedLabel,
  requestedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Optional new plan text is intentionally bounded and never persisted as provider credentials. */
  planRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskControlKind = z.infer<typeof taskControlKindSchema>;
export type TaskIntentMode = z.infer<typeof taskIntentModeSchema>;
export type TaskDeliveryMode = z.infer<typeof taskDeliveryModeSchema>;
export type TaskProgressWitness = z.infer<typeof taskProgressWitnessSchema>;
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>;
export type TaskObservation = z.infer<typeof taskObservationSchema>;
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;
export type TaskDecision = z.infer<typeof taskDecisionSchema>;
export type TaskParticipant = z.infer<typeof taskParticipantSchema>;
export type TaskContext = z.infer<typeof taskContextSchema>;
export type TaskControl = z.infer<typeof taskControlSchema>;

export type TaskControlResult =
  | { readonly ok: true; readonly context: TaskContext; readonly changed: boolean; readonly newTask: boolean }
  | { readonly ok: false; readonly code: "invalid" | "terminal" | "not-applicable" | "new-task"; readonly error: string; readonly context: TaskContext };

export type ProgressResult =
  | { readonly ok: true; readonly accepted: boolean; readonly waiting: boolean; readonly context: TaskContext }
  | { readonly ok: false; readonly code: "invalid" | "terminal"; readonly error: string; readonly context: TaskContext };

export interface TaskContextStore {
  snapshot(): TaskContext;
  applyControl(control: TaskControl): TaskControlResult;
  recordObservation(observation: TaskObservation): TaskContext;
  recordArtifact(artifact: TaskArtifact): TaskContext;
  setDecision(decision: TaskDecision): TaskContext;
  recordProgress(witness: TaskProgressWitness): ProgressResult;
  requestUserInput(at?: number): TaskContext;
  complete(at?: number): TaskContext;
  claimAssignment(assignment: TaskAssignment):
    | { readonly ok: true; readonly context: TaskContext; readonly duplicate: boolean }
    | { readonly ok: false; readonly code: "invalid" | "conflict" | "terminal"; readonly error: string; readonly context: TaskContext };
  releaseAssignment(assignmentId: string, at?: number): TaskContext;
}

export interface CreateTaskContextInput {
  readonly taskId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly intentMode?: TaskIntentMode;
  readonly allowAdvance?: boolean;
  readonly allowSubmit?: boolean;
  readonly participants: readonly TaskParticipant[];
  readonly now?: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseContext(value: unknown): TaskContext {
  return taskContextSchema.parse(value);
}

function update(context: TaskContext, patch: Partial<TaskContext>, at: number): TaskContext {
  return parseContext({ ...context, ...patch, updatedAt: Math.max(context.updatedAt, at) });
}

/**
 * Create one task-local state machine. It is intentionally in-memory: the
 * broker/store owns persistence, while this module makes every transition
 * explicit and testable before it is persisted.
 */
export function createTaskContext(input: CreateTaskContextInput): TaskContextStore {
  const at = input.now ?? Date.now();
  let context = parseContext({
    taskId: input.taskId,
    conversationId: input.conversationId,
    runId: input.runId,
    state: "active",
    intentMode: input.intentMode ?? "prepare",
    allowAdvance: input.allowAdvance ?? false,
    allowSubmit: input.allowSubmit ?? false,
    planRevision: 0,
    participants: input.participants,
    assignments: [],
    observations: [],
    artifacts: [],
    pendingDecisions: [],
    progress: { noProgressStreak: 0 },
    createdAt: at,
    updatedAt: at,
  });

  const terminal = () => context.state === "completed" || context.state === "canceled";
  const transition = (state: TaskState, timestamp: number, patch: Partial<TaskContext> = {}) => {
    context = update(context, { ...patch, state }, timestamp);
  };

  return {
    snapshot() { return clone(context); },

    applyControl(inputControl) {
      let control: TaskControl;
      try { control = taskControlSchema.parse(inputControl); }
      catch (error) {
        return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid task control.", context: clone(context) };
      }
      if (control.taskId !== context.taskId) return { ok: false, code: "invalid", error: "Task control belongs to a different task.", context: clone(context) };
      if (control.kind === "new-task") return { ok: false, code: "new-task", error: "A new task requires a new task context.", context: clone(context) };
      if (terminal()) return { ok: false, code: "terminal", error: "A terminal task cannot receive another control.", context: clone(context) };
      const before = context;
      switch (control.kind) {
        case "pause":
          if (context.state === "paused-owner") return { ok: true, context: clone(context), changed: false, newTask: false };
          transition("paused-owner", control.requestedAt);
          break;
        case "resume":
        case "continuation":
          if (context.state === "paused-owner" || context.state === "waiting-user" || context.state === "waiting-agent") transition("active", control.requestedAt);
          break;
        case "clarification":
          transition("replanning", control.requestedAt, { planRevision: context.planRevision + 1 });
          break;
        case "redirect":
          transition("active", control.requestedAt, { planRevision: context.planRevision + 1, progress: { noProgressStreak: 0 } });
          break;
        case "cancel":
          transition("canceled", control.requestedAt);
          break;
      }
      return { ok: true, context: clone(context), changed: before.updatedAt !== context.updatedAt || before.state !== context.state, newTask: false };
    },

    recordObservation(observation) {
      if (terminal()) return clone(context);
      const parsed = taskObservationSchema.parse(observation);
      const next = context.observations.filter((item) => item.surfaceId !== parsed.surfaceId);
      next.push(parsed);
      context = update(context, { observations: next.slice(-128), progress: { noProgressStreak: 0 } }, parsed.observedAt);
      return clone(context);
    },

    recordArtifact(artifactInput) {
      if (terminal()) return clone(context);
      const artifact = taskArtifactSchema.parse(artifactInput);
      const artifacts = context.artifacts.filter((item) => item.artifactId !== artifact.artifactId);
      artifacts.push(artifact);
      context = update(context, { artifacts: artifacts.slice(-128), progress: { noProgressStreak: 0 } }, artifact.updatedAt);
      return clone(context);
    },

    setDecision(decisionInput) {
      if (terminal()) return clone(context);
      const decision = taskDecisionSchema.parse(decisionInput);
      const decisions = context.pendingDecisions.filter((item) => item.decisionId !== decision.decisionId);
      decisions.push(decision);
      context = update(context, { pendingDecisions: decisions.slice(-64) }, decision.updatedAt);
      return clone(context);
    },

    recordProgress(witnessInput) {
      let witness: TaskProgressWitness;
      try { witness = taskProgressWitnessSchema.parse(witnessInput); }
      catch (error) {
        return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid progress witness.", context: clone(context) };
      }
      if (terminal()) return { ok: false, code: "terminal", error: "A terminal task cannot record progress.", context: clone(context) };
      const prior = context.progress.lastWitness;
      const duplicate = prior?.stateFingerprint === witness.stateFingerprint && prior.kind === witness.kind;
      const streak = duplicate ? context.progress.noProgressStreak + 1 : 0;
      const waiting = streak >= 3;
      context = update(context, {
        progress: { lastWitness: witness, noProgressStreak: Math.min(32, streak) },
        state: waiting ? "waiting-agent" : context.state === "waiting-agent" ? "active" : context.state,
      }, witness.at);
      return { ok: true, accepted: !duplicate, waiting, context: clone(context) };
    },

    requestUserInput(timestamp = Date.now()) {
      if (!terminal()) transition("waiting-user", timestamp);
      return clone(context);
    },

    complete(timestamp = Date.now()) {
      if (!terminal()) transition("completed", timestamp);
      return clone(context);
    },

    claimAssignment(assignmentInput) {
      let assignment: TaskAssignment;
      try { assignment = taskAssignmentSchema.parse(assignmentInput); }
      catch (error) {
        return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid task assignment.", context: clone(context) };
      }
      if (terminal()) return { ok: false, code: "terminal", error: "A terminal task cannot claim work.", context: clone(context) };
      if (!context.participants.some((participant) => participant.agentId === assignment.agentId)) {
        return { ok: false, code: "invalid", error: "Assignment agent is not a task participant.", context: clone(context) };
      }
      const existing = context.assignments.find((item) => item.assignmentId === assignment.assignmentId);
      if (existing) {
        const same = JSON.stringify(existing) === JSON.stringify(assignment);
        return same
          ? { ok: true, context: clone(context), duplicate: true }
          : { ok: false, code: "conflict", error: "Assignment ID is already bound to different work.", context: clone(context) };
      }
      const activeSameWork = context.assignments.find((item) => item.workKey === assignment.workKey && ["proposed", "claimed"].includes(item.status));
      if (activeSameWork && activeSameWork.agentId !== assignment.agentId) {
        return { ok: false, code: "conflict", error: `Work ${assignment.workKey} is already claimed by ${activeSameWork.agentId}.`, context: clone(context) };
      }
      context = update(context, { assignments: [...context.assignments, assignment].slice(-128) }, assignment.updatedAt);
      return { ok: true, context: clone(context), duplicate: false };
    },

    releaseAssignment(assignmentId, timestamp = Date.now()) {
      if (terminal()) return clone(context);
      const assignments = context.assignments.map((item) => item.assignmentId === assignmentId ? { ...item, status: "released" as const, updatedAt: timestamp } : item);
      context = update(context, { assignments }, timestamp);
      return clone(context);
    },
  };
}

