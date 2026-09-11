/**
 * Durable half of the bridge's usage-limit cooldown (bridge-runtime.ts,
 * detectUsageLimitCooldownUntil / recordUsageLimitCooldownIfApplicable). That
 * logic already correctly parses a provider's own stated reset time into a
 * real, multi-week-future cooldown -- but it only ever lived in a plain
 * in-memory Map inside one resident process, wiped by any restart (a crash, a
 * routine machine reboot), which silently re-exposes the provider to hitting
 * its usage limit again before re-establishing quiet. This module is the
 * write-once / read-once-per-process durable record: the bridge's own hot
 * per-message check stays a pure in-memory lookup, unaffected.
 */

import { supabase } from "@/lib/supabase";
import type { AuthedAgent } from "@/lib/agent-join-service";

function requireService() {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return supabase;
}

/** Record (or extend) a usage-limit cooldown for this agent's connection in one conversation. Best-effort by design -- see the two call sites in the API route for why a write failure must never block the in-memory cooldown that already protects the current process. */
export async function recordUsageLimitCooldown(agent: AuthedAgent, input: { conversationId: string; cooldownUntil: string; reason: string }): Promise<void> {
  const db = requireService();
  const { error } = await db.from("agent_usage_limit_cooldowns").upsert({
    workspace_id: agent.workspaceId,
    connection_id: agent.connectionId,
    conversation_id: input.conversationId,
    cooldown_until: input.cooldownUntil,
    reason: input.reason.slice(0, 500),
    updated_at: new Date().toISOString(),
  }, { onConflict: "connection_id,conversation_id" });
  if (error) throw new Error(`Could not persist the usage-limit cooldown: ${error.message}`);
}

/** The durable cooldown for this agent's connection in one conversation, or null if none is recorded (or it already passed). Never guesses: a missing/expired row means no cooldown, not an error. */
export async function readUsageLimitCooldown(agent: AuthedAgent, conversationId: string): Promise<{ cooldownUntil: string; reason: string } | null> {
  const db = requireService();
  const { data, error } = await db
    .from("agent_usage_limit_cooldowns")
    .select("cooldown_until, reason")
    .eq("workspace_id", agent.workspaceId)
    .eq("connection_id", agent.connectionId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the usage-limit cooldown: ${error.message}`);
  if (!data) return null;
  const until = String(data.cooldown_until);
  if (Date.parse(until) <= Date.now()) return null;
  return { cooldownUntil: until, reason: String(data.reason) };
}
