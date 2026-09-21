/**
 * Shadow mode for "should this human message wake an agent?".
 *
 * Jev judges every human channel message in parallel with the routing that already exists
 * (explicit @mentions). It changes nothing: no dispatch, no notice, no state. Each judgment is
 * logged next to what the current logic decided so agreement can be measured on real traffic
 * before anyone lets it influence behavior.
 *
 * Privacy: the message body is sent to TypeSafe (that is the point) but is never logged here.
 */
import { choice, noul } from "@typesafe-ai/sdk";
import { jevJudge, jevMode, type JevMode, type JevTransport } from "@/lib/jev";

export interface ShadowAgent {
  kind: string;
  connected: boolean;
  isChannelMember: boolean;
}

export interface ShadowInput {
  messageId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  /** Which delivery path saw the message: the live Relay socket or the dashboard HTTP fallback. */
  source?: "relay" | "http";
  body: string;
  channelTopic?: string | null;
  agents: ShadowAgent[];
  /** Provider kinds the current logic resolved from explicit @mentions. */
  actualMentionedKinds: string[];
}

export interface ShadowRecord {
  schema: "m9r.jev.shadow.v1";
  messageId: string;
  workspaceId: string | null;
  conversationId: string | null;
  source: "relay" | "http" | null;
  mode: JevMode;
  status: "judged" | "unavailable";
  isTask: number | null;
  target: string | null;
  targetConfidence: number | null;
  actualMentioned: string[];
  /** Whether Jev would have woken the same agent(s) the current logic did; null when unavailable. */
  agree: boolean | null;
  latencyMs: number | null;
  model: string | null;
  inputTokens: number | null;
}

/** Provisional. The right value is decided from shadow data, not guessed here. */
export const SHADOW_TASK_THRESHOLD = 0.5;

const MAX_BODY_CHARS = 2_000;

/** Best-effort insert into jev_shadow_decisions. A missing table or database outage is silent by design. */
export async function persistShadowRecord(record: ShadowRecord): Promise<void> {
  try {
    const { supabase } = await import("@/lib/supabase");
    if (!supabase) return;
    await supabase.from("jev_shadow_decisions").insert({
      message_id: record.messageId,
      workspace_id: record.workspaceId,
      conversation_id: record.conversationId,
      source: record.source,
      mode: record.mode,
      status: record.status,
      is_task: record.isTask,
      target: record.target,
      target_confidence: record.targetConfidence,
      actual_mentioned: record.actualMentioned,
      agree: record.agree,
      latency_ms: record.latencyMs,
      model: record.model,
      input_tokens: record.inputTokens,
    });
  } catch {
    /* observability must never affect message handling */
  }
}
const recentlyJudged = new Set<string>();

/** One agent per kind is enough for "who is this for"; connected and in-channel agents first. */
function rosterKinds(agents: ShadowAgent[]): string[] {
  const seen = new Map<string, number>();
  for (const agent of agents) {
    const rank = (agent.connected ? 2 : 0) + (agent.isChannelMember ? 1 : 0);
    seen.set(agent.kind, Math.max(seen.get(agent.kind) ?? 0, rank));
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([kind]) => kind).slice(0, 6);
}

export function buildShadowQuestions(kinds: string[]) {
  const targetCriteria: Record<string, string> = Object.fromEntries(kinds.map((kind) => [kind, `The message is meant for the ${kind} agent.`]));
  targetCriteria.none = "The message is not meant for any of these agents, or it is unclear who it is for.";
  return {
    is_task: noul(
      "Is `message` asking an AI coding agent to do work (investigate, write or change code, run or review something, plan, or answer a technical question about the project), as opposed to casual chat, thanks, status updates, or talk between people?",
      {
        true: "It asks for work or a technical answer that an agent could act on.",
        false: "It is chat, thanks, an update, or directed at a human.",
      },
    ),
    target: choice(
      "Which agent is `message` meant for? Judge the intent of the message, not merely whether a name appears in it.",
      targetCriteria,
    ),
  } as const;
}

/** Pure comparison so the rule is testable and visible: would Jev have woken what the current logic woke? */
export function shadowAgreement(input: { isTask: number; target: string; actualMentioned: string[] }): boolean {
  const jevWouldDispatch = input.isTask >= SHADOW_TASK_THRESHOLD && input.target !== "none";
  const currentDispatches = input.actualMentioned.length > 0;
  if (jevWouldDispatch !== currentDispatches) return false;
  return !currentDispatches || input.actualMentioned.includes(input.target);
}

export async function shadowJudgeHumanMessage(input: ShadowInput, options: { transport?: JevTransport; mode?: JevMode; log?: (record: ShadowRecord) => void; persist?: (record: ShadowRecord) => Promise<void> } = {}): Promise<ShadowRecord | null> {
  const mode = options.mode ?? jevMode();
  if (mode === "off" || !input.body.trim()) return null;
  if (recentlyJudged.has(input.messageId)) return null; // idempotent replays re-enter this path
  recentlyJudged.add(input.messageId);
  if (recentlyJudged.size > 500) recentlyJudged.delete(recentlyJudged.values().next().value as string);

  const kinds = rosterKinds(input.agents);
  const judgment = await jevJudge(
    {
      message: input.body.slice(0, MAX_BODY_CHARS),
      channel: input.channelTopic ?? null,
      agents: kinds,
    },
    buildShadowQuestions(kinds),
    { mode, transport: options.transport },
  );

  const base = {
    schema: "m9r.jev.shadow.v1" as const,
    messageId: input.messageId,
    workspaceId: input.workspaceId ?? null,
    conversationId: input.conversationId ?? null,
    source: input.source ?? null,
    mode,
    actualMentioned: input.actualMentionedKinds,
  };
  const record: ShadowRecord = judgment
    ? (() => {
        const isTask = judgment.answers.is_task.noul;
        const target = judgment.answers.target.choice;
        return {
          ...base,
          status: "judged" as const,
          isTask,
          target,
          targetConfidence: judgment.answers.target.confidence,
          agree: shadowAgreement({ isTask, target, actualMentioned: input.actualMentionedKinds }),
          latencyMs: judgment.latencyMs,
          model: judgment.model,
          inputTokens: judgment.inputTokens,
        };
      })()
    : { ...base, status: "unavailable" as const, isTask: null, target: null, targetConfidence: null, agree: null, latencyMs: null, model: null, inputTokens: null };
  (options.log ?? ((entry) => console.info(`[jev-shadow] ${JSON.stringify(entry)}`)))(record);
  // Container logs are not reachable from the CLI, so the durable copy is what analysis reads.
  await (options.persist ?? persistShadowRecord)(record);
  return record;
}

/**
 * Fire-and-forget entry point for request handlers. The judgment runs after the response is
 * sent (Next `after`, which OpenNext maps to the Worker's waitUntil), so it can never add latency
 * to sending a message; outside a request scope it falls back to a plain detached promise.
 * Never throws.
 */
export function scheduleShadowJudgment(input: ShadowInput): void {
  if (jevMode() === "off") return;
  const run = () => shadowJudgeHumanMessage(input).catch(() => null);
  // Loaded lazily: `next/server` only resolves inside the Next runtime, and this module is also
  // imported by plain-Node tests. Async context survives the promise hop, so `after` still sees the request.
  void import("next/server")
    .then(({ after }) => { try { after(run); } catch { void run(); } })
    .catch(() => { void run(); });
}
