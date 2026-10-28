import { z } from "zod";

/**
 * Phase 1 multiplayer contract.
 *
 * This module is deliberately provider- and surface-neutral. It defines the
 * correlation vocabulary that later phases will use to coordinate work, but it
 * does not dispatch providers, acquire desktop input, or change the existing
 * browser-control route.
 */

export const MULTIPLAYER_CONTRACT_VERSION = 1 as const;
export const MAX_ACTIVE_AGENTS = 16 as const;
export const SUPPORTED_AGENT_COUNTS = [1, 2, 4, 8, 16] as const;
export const MAX_A2A_REPLY_DEPTH = 8 as const;

const identifier = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/, "M9R identifiers may only contain letters, numbers, '.', '_', ':', '%', and '-'.");

const shortLabel = z.string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "M9R labels cannot contain control characters.");

const summary = z.string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "M9R summaries cannot contain control characters.");

const idempotencyKey = z.string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/, "M9R idempotency keys may only contain safe identifier characters.");

const timestampMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const uniqueIdentifiers = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** The immutable correlation identity shared by every multiplayer record. */
export const multiplayerCorrelationSchema = z.object({
  runId: identifier,
  branchId: identifier,
  agentId: identifier,
}).strict();

/** A provider identity in a run. Provider session IDs and credentials are not part of this contract. */
export const multiplayerAgentSchema = z.object({
  agentId: identifier,
  branchId: identifier,
  provider: shortLabel,
  handle: shortLabel.optional(),
}).strict();

/** A roster is bounded to the product's 16-agent surface, not a two-agent special case. */
export const multiplayerRosterSchema = z.object({
  runId: identifier,
  agents: z.array(multiplayerAgentSchema)
    .min(1)
    .max(MAX_ACTIVE_AGENTS)
    .superRefine((agents, context) => {
      if (!uniqueIdentifiers(agents.map((agent) => agent.agentId))) {
        context.addIssue({ code: "custom", path: ["agentId"], message: "Agent identities must be unique within a run." });
      }
      if (!uniqueIdentifiers(agents.map((agent) => agent.branchId))) {
        context.addIssue({ code: "custom", path: ["branchId"], message: "Branch identities must be unique within a run." });
      }
    }),
}).strict();

/** A target surface. Region is optional because some operations address a whole surface. */
export const multiplayerSurfaceSchema = z.object({
  surfaceId: identifier,
  regionId: identifier.optional(),
  revision,
}).strict();

/** A revisioned operation is the smallest mutation unit that can be fenced. */
export const multiplayerOperationSchema = multiplayerCorrelationSchema.extend({
  operationId: identifier,
  surfaceId: identifier,
  regionId: identifier.optional(),
  revision,
  kind: z.enum(["observe", "prepare", "mutate", "verify", "handoff"]),
  createdAt: timestampMs,
}).strict();

export const leaseStateSchema = z.enum(["requested", "active", "released", "expired", "revoked"]);

/**
 * A lease fences conflicting mutations. It does not grant provider
 * authentication or Windows input authority; those remain later-phase policy.
 */
export const multiplayerLeaseSchema = multiplayerCorrelationSchema.extend({
  leaseId: identifier,
  surfaceId: identifier,
  regionId: identifier.optional(),
  operationId: identifier.optional(),
  holderAgentId: identifier,
  revision,
  state: leaseStateSchema,
  issuedAt: timestampMs,
  expiresAt: timestampMs,
}).strict().superRefine((lease, context) => {
  if (lease.expiresAt <= lease.issuedAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "A lease must expire after it is issued." });
  }
  if (lease.holderAgentId !== lease.agentId) {
    context.addIssue({ code: "custom", path: ["holderAgentId"], message: "The lease holder must match the correlated agent." });
  }
});

export const a2aMessageKindSchema = z.enum([
  "help-request",
  "help-result",
  "delegate",
  "blocker",
  "surface-handoff",
  "edit-confirmation",
  "verification-request",
  "stop",
  "supersede",
]);

const a2aRecipientSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: identifier }).strict(),
  z.object({
    kind: z.literal("group"),
    agentIds: z.array(identifier)
      .min(1)
      .max(MAX_ACTIVE_AGENTS)
      .refine(uniqueIdentifiers, "A2A group recipients must be unique."),
  }).strict(),
]);

const structuredValueSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
const structuredDetailsSchema = z.record(identifier, structuredValueSchema).superRefine((details, context) => {
  if (Object.keys(details).length > 32) {
    context.addIssue({ code: "custom", message: "A2A details may contain at most 32 fields." });
  }
});

/** A bounded, idempotent, structured agent-to-agent message. */
export const a2aMessageSchema = multiplayerCorrelationSchema.extend({
  schemaVersion: z.literal(MULTIPLAYER_CONTRACT_VERSION),
  messageId: identifier,
  recipient: a2aRecipientSchema,
  kind: a2aMessageKindSchema,
  priority: z.enum(["low", "normal", "high", "urgent"]),
  idempotencyKey,
  createdAt: timestampMs,
  expiresAt: timestampMs.optional(),
  summary,
  details: structuredDetailsSchema.optional(),
  operationId: identifier.optional(),
  replyToMessageId: identifier.optional(),
  supersedesMessageId: identifier.optional(),
  replyDepth: z.number().int().min(0).max(MAX_A2A_REPLY_DEPTH),
}).strict().superRefine((message, context) => {
  if (message.expiresAt !== undefined && message.expiresAt <= message.createdAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "An A2A message must expire after it is created." });
  }
  if (message.recipient.kind === "agent" && message.recipient.agentId === message.agentId) {
    context.addIssue({ code: "custom", path: ["recipient", "agentId"], message: "A2A messages cannot target the sending agent." });
  }
  if (message.recipient.kind === "group" && message.recipient.agentIds.includes(message.agentId)) {
    context.addIssue({ code: "custom", path: ["recipient", "agentIds"], message: "A2A group recipients cannot include the sending agent." });
  }
});

export const presenceStateSchema = z.enum([
  "thinking",
  "asking",
  "preparing",
  "observing",
  "acting",
  "waiting",
  "blocked",
  "completed",
  "stopped",
]);

/** Compact presence is derived from structured activity, not raw provider logs. */
export const presenceEventSchema = multiplayerCorrelationSchema.extend({
  schemaVersion: z.literal(MULTIPLAYER_CONTRACT_VERSION),
  presenceId: identifier,
  surfaceId: identifier.optional(),
  regionId: identifier.optional(),
  operationId: identifier.optional(),
  state: presenceStateSchema,
  revision,
  occurredAt: timestampMs,
  summary: shortLabel.optional(),
}).strict();

export const cancellationScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("operation"), runId: identifier, branchId: identifier, agentId: identifier, operationId: identifier }).strict(),
  z.object({ scope: z.literal("agent"), runId: identifier, branchId: identifier, agentId: identifier }).strict(),
  z.object({ scope: z.literal("branch"), runId: identifier, branchId: identifier }).strict(),
  z.object({ scope: z.literal("run"), runId: identifier }).strict(),
]);

/** Cancellation is explicit and hierarchical; sibling branches remain alive unless the run is stopped. */
export const cancellationRequestSchema = z.object({
  schemaVersion: z.literal(MULTIPLAYER_CONTRACT_VERSION),
  cancellationId: identifier,
  scope: cancellationScopeSchema,
  reason: shortLabel,
  requestedAt: timestampMs,
}).strict();

export type MultiplayerCorrelation = z.infer<typeof multiplayerCorrelationSchema>;
export type MultiplayerAgent = z.infer<typeof multiplayerAgentSchema>;
export type MultiplayerRoster = z.infer<typeof multiplayerRosterSchema>;
export type MultiplayerSurface = z.infer<typeof multiplayerSurfaceSchema>;
export type MultiplayerOperation = z.infer<typeof multiplayerOperationSchema>;
export type MultiplayerLease = z.infer<typeof multiplayerLeaseSchema>;
export type A2ARecipient = z.infer<typeof a2aRecipientSchema>;
export type A2AMessageKind = z.infer<typeof a2aMessageKindSchema>;
export type A2AMessage = z.infer<typeof a2aMessageSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type PresenceEvent = z.infer<typeof presenceEventSchema>;
export type CancellationScope = z.infer<typeof cancellationScopeSchema>;
export type CancellationRequest = z.infer<typeof cancellationRequestSchema>;

export type AgentCountValidation =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: string };

/** Validate a requested roster size without limiting normal runs to two agents. */
export function validateAgentCount(count: number): AgentCountValidation {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ACTIVE_AGENTS) {
    return { ok: false, error: `M9R supports between 1 and ${MAX_ACTIVE_AGENTS} active agents per run.` };
  }
  return { ok: true, count };
}

export type RosterValidation =
  | { readonly ok: true; readonly roster: MultiplayerRoster }
  | { readonly ok: false; readonly error: string };

/** Parse and validate a complete bounded roster before it enters coordination state. */
export function validateMultiplayerRoster(value: unknown): RosterValidation {
  const parsed = multiplayerRosterSchema.safeParse(value);
  return parsed.success
    ? { ok: true, roster: parsed.data }
    : { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "roster"}: ${issue.message}`).join("; ") };
}

export const parseMultiplayerCorrelation = (value: unknown): MultiplayerCorrelation => multiplayerCorrelationSchema.parse(value);
export const parseMultiplayerSurface = (value: unknown): MultiplayerSurface => multiplayerSurfaceSchema.parse(value);
export const parseMultiplayerOperation = (value: unknown): MultiplayerOperation => multiplayerOperationSchema.parse(value);
export const parseMultiplayerLease = (value: unknown): MultiplayerLease => multiplayerLeaseSchema.parse(value);
export const parseA2AMessage = (value: unknown): A2AMessage => a2aMessageSchema.parse(value);
export const parsePresenceEvent = (value: unknown): PresenceEvent => presenceEventSchema.parse(value);
export const parseCancellationRequest = (value: unknown): CancellationRequest => cancellationRequestSchema.parse(value);
