/**
 * Channel workflow automation — the Buzz-parity gap this closes.
 * ----------------------------------------------------------------------------
 * Buzz authors workflows in YAML (crates/buzz-workflow/src/schema.rs):
 * a `trigger` (message_posted/reaction_added/diff_posted/schedule/webhook)
 * fires an ordered list of `steps`, each an action (send_message, send_dm,
 * set_channel_topic, add_reaction, call_webhook, request_approval, delay).
 *
 * This is a deliberately narrower port, not a full re-implementation:
 * - Trigger: `message_posted` fires on every channel message. `schedule`
 *   fires too, but only its `interval` form (e.g. "30m", "6h", "1d") —
 *   workflow-scheduler-service.ts's sweep can compute an interval's next run
 *   without a cron-expression parser this codebase doesn't have. A `cron`
 *   schedule trigger still parses and validates (so definitions authored
 *   against the wider schema round-trip) but is never picked up by the
 *   sweep — see EXECUTABLE_TRIGGERS and isScheduleTriggerFireable below,
 *   checked explicitly before dispatch rather than silently accepted and
 *   then never fired.
 * - Filter: a plain case-insensitive substring match on the trigger message
 *   body, not Buzz's evalexpr expression language. This is a real, honest
 *   scoping decision, not a stand-in for the real thing.
 * - Actions: `send_message` (posts into the Mission via postMissionMessage)
 *   and `request_approval` (transitions the Mission to ready_for_decision via
 *   requestMissionDecision, OathLock's actual human-decision gate). Buzz's
 *   `call_webhook` is intentionally omitted — Buzz itself gates it behind
 *   elevated channel authority because it can exfiltrate channel content
 *   (see schema.rs's `requires_elevated_authority`/SEC-006); OathLock has no
 *   outbound-webhook egress path anywhere else in the codebase, and adding
 *   one only for this feature is exactly the kind of scope creep this repo's
 *   conventions reject. `send_dm`, `set_channel_topic`, `add_reaction`, and
 *   `delay` are omitted because OathLock's channel model has no DM-to-agent,
 *   topic, or reaction primitive this could route through today.
 */

export const CHANNEL_WORKFLOW_TRIGGER_KINDS = ["message_posted", "schedule"] as const;
export type ChannelWorkflowTriggerKind = (typeof CHANNEL_WORKFLOW_TRIGGER_KINDS)[number];

/** Only triggers actually wired to a firing path. Kept separate from the
 *  parseable schema so "accepted at save time" never silently means "will
 *  never fire" without the definition author being told which is which. */
export const EXECUTABLE_TRIGGERS: ReadonlySet<ChannelWorkflowTriggerKind> = new Set(["message_posted", "schedule"]);

/** Within the `schedule` trigger, only `interval` actually fires (see the module comment) — a `cron`-only schedule passes validation but this returns false for it. */
export function isScheduleTriggerFireable(trigger: ChannelWorkflowTrigger): boolean {
  return trigger.on === "schedule" && typeof trigger.interval === "string";
}

const INTERVAL_PATTERN = /^(\d+)(s|m|h|d)$/;
const INTERVAL_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_INTERVAL_MS = 60_000; // A sweep can only fire as often as it's invoked (Vercel Cron); a sub-minute interval would just be a lie about precision.

/** Parses "30s"/"5m"/"6h"/"1d" into milliseconds, or null for anything else (a bare cron expression, garbage, or below the floor a periodic sweep can actually honor). */
export function parseIntervalMs(interval: string): number | null {
  const match = INTERVAL_PATTERN.exec(interval.trim());
  if (!match) return null;
  const ms = Number(match[1]) * INTERVAL_UNIT_MS[match[2]];
  return ms >= MIN_INTERVAL_MS ? ms : null;
}

export const CHANNEL_WORKFLOW_ACTION_KINDS = ["send_message", "request_approval"] as const;
export type ChannelWorkflowActionKind = (typeof CHANNEL_WORKFLOW_ACTION_KINDS)[number];

export interface MessagePostedTrigger {
  on: "message_posted";
  /** Case-insensitive substring match against the trigger message body. Omit to match every message. */
  filter?: string;
}

export interface ScheduleTrigger {
  on: "schedule";
  cron?: string;
  interval?: string;
}

export type ChannelWorkflowTrigger = MessagePostedTrigger | ScheduleTrigger;

export interface SendMessageAction {
  action: "send_message";
  /** Supports {{trigger.body}} and {{trigger.author}} template variables. */
  text: string;
}

export interface RequestApprovalAction {
  action: "request_approval";
  /** Shown alongside the Mission's ready_for_decision transition; not a routable recipient. */
  message: string;
}

export type ChannelWorkflowAction = SendMessageAction | RequestApprovalAction;

export interface ChannelWorkflowStep {
  id: string;
  name?: string;
  action: ChannelWorkflowAction;
}

export interface ChannelWorkflowDef {
  name: string;
  description?: string;
  trigger: ChannelWorkflowTrigger;
  steps: ChannelWorkflowStep[];
  enabled: boolean;
}

export class WorkflowDefinitionError extends Error {}

const VALID_STEP_ID = /^[A-Za-z0-9_]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrigger(raw: unknown): ChannelWorkflowTrigger {
  if (!isRecord(raw)) throw new WorkflowDefinitionError("trigger is required and must be an object.");
  const on = raw.on;
  if (on === "message_posted") {
    const filter = raw.filter;
    if (filter !== undefined && typeof filter !== "string") throw new WorkflowDefinitionError("trigger.filter must be a string.");
    return { on: "message_posted", filter: filter?.trim() || undefined };
  }
  if (on === "schedule") {
    const cron = raw.cron;
    const interval = raw.interval;
    if (cron !== undefined && typeof cron !== "string") throw new WorkflowDefinitionError("trigger.cron must be a string.");
    if (interval !== undefined && typeof interval !== "string") throw new WorkflowDefinitionError("trigger.interval must be a string.");
    if (!cron && !interval) throw new WorkflowDefinitionError("schedule trigger requires either 'cron' or 'interval'.");
    if (cron && interval) throw new WorkflowDefinitionError("schedule trigger cannot specify both 'cron' and 'interval'.");
    if (interval && parseIntervalMs(interval) === null) {
      throw new WorkflowDefinitionError("trigger.interval must look like '30m', '6h', or '1d' (whole number + s/m/h/d, at least 60s).");
    }
    return { on: "schedule", cron: cron || undefined, interval: interval || undefined };
  }
  throw new WorkflowDefinitionError(`trigger.on '${String(on)}' is not supported. Use one of: ${CHANNEL_WORKFLOW_TRIGGER_KINDS.join(", ")}.`);
}

/**
 * Accepts either shape a step's action can arrive in: the raw YAML/JSON form
 * (`action`/`text`/`message` as flat siblings on the step object, as an
 * author writes it) or an already-parsed ChannelWorkflowAction (`action`
 * nested one level under its own `action` key, as parseAction itself
 * returns it). The second case matters because toRecord
 * (mission-workflow-store.ts) re-validates `definition_json` read back from
 * storage through this same parser -- and what's stored there is already
 * the parsed/structured shape, not the original YAML. Without this,
 * parse(parse(x)) !== parse(x): a freshly created workflow's own read-back
 * would fail immediately, since the second pass would see `raw.action` as
 * an object instead of a discriminant string.
 */
function parseAction(raw: unknown): ChannelWorkflowAction {
  if (!isRecord(raw)) throw new WorkflowDefinitionError("step action must be an object.");
  const source = isRecord(raw.action) ? raw.action : raw;
  const action = source.action;
  if (action === "send_message") {
    const text = source.text;
    if (typeof text !== "string" || !text.trim()) throw new WorkflowDefinitionError("send_message requires non-empty 'text'.");
    if (text.length > 4_000) throw new WorkflowDefinitionError("send_message 'text' must be at most 4000 characters.");
    return { action: "send_message", text };
  }
  if (action === "request_approval") {
    const message = source.message;
    if (typeof message !== "string" || !message.trim()) throw new WorkflowDefinitionError("request_approval requires non-empty 'message'.");
    if (message.length > 2_000) throw new WorkflowDefinitionError("request_approval 'message' must be at most 2000 characters.");
    return { action: "request_approval", message };
  }
  throw new WorkflowDefinitionError(`step.action '${String(action)}' is not supported. Use one of: ${CHANNEL_WORKFLOW_ACTION_KINDS.join(", ")}.`);
}

function parseStep(raw: unknown): ChannelWorkflowStep {
  if (!isRecord(raw)) throw new WorkflowDefinitionError("each step must be an object.");
  const id = raw.id;
  if (typeof id !== "string" || !VALID_STEP_ID.test(id)) {
    throw new WorkflowDefinitionError(`step id '${String(id)}' is invalid: must be 1-64 alphanumeric/underscore characters.`);
  }
  const name = raw.name;
  if (name !== undefined && typeof name !== "string") throw new WorkflowDefinitionError("step.name must be a string.");
  return { id, name: name || undefined, action: parseAction(raw) };
}

/** Parses and validates a workflow definition already decoded from YAML/JSON into a plain object. */
export function parseChannelWorkflowDefinition(raw: unknown): ChannelWorkflowDef {
  if (!isRecord(raw)) throw new WorkflowDefinitionError("workflow definition must be an object.");
  const name = raw.name;
  if (typeof name !== "string" || !name.trim()) throw new WorkflowDefinitionError("name is required and must not be empty.");
  if (name.length > 200) throw new WorkflowDefinitionError("name must be at most 200 characters.");

  const description = raw.description;
  if (description !== undefined && typeof description !== "string") throw new WorkflowDefinitionError("description must be a string.");

  const trigger = parseTrigger(raw.trigger);

  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new WorkflowDefinitionError("at least one step is required.");
  if (rawSteps.length > 16) throw new WorkflowDefinitionError("at most 16 steps are supported.");
  const steps = rawSteps.map(parseStep);
  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.id)) throw new WorkflowDefinitionError(`duplicate step id: ${step.id}`);
    seenIds.add(step.id);
  }

  const enabled = raw.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new WorkflowDefinitionError("enabled must be a boolean.");

  return { name: name.trim(), description: description?.trim() || undefined, trigger, steps, enabled: enabled ?? true };
}

/** Renders {{trigger.body}} / {{trigger.author}} template variables. Unknown variables are left as-is, never silently dropped. */
export function renderWorkflowTemplate(text: string, vars: { body: string; author: string }): string {
  return text.replace(/\{\{\s*trigger\.(body|author)\s*\}\}/g, (_match, key: string) => (key === "body" ? vars.body : vars.author));
}

/** Buzz's `message_posted` filter is an evalexpr expression; this is a plain
 *  case-insensitive substring match — see the module comment for why. */
export function matchesMessagePostedFilter(trigger: MessagePostedTrigger, messageBody: string): boolean {
  if (!trigger.filter) return true;
  return messageBody.toLowerCase().includes(trigger.filter.toLowerCase());
}
