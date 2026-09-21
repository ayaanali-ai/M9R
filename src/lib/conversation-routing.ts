import { providerLabel, providerMention } from "@/lib/provider-adapter-config";
import { PRESENCE_FRESH_MS } from "@/lib/agent-presence";

const KNOWN_AGENT_MENTION_NAMES = ["claude", "claude-code", "codex", "opencode", "grok", "grok-build"] as const;

/** One liveness boundary for routing and presentation. The agent heartbeat
 * lease is the product's proof that a local runtime is still reachable. */
export const RECENT_CONNECTION_MAX_AGE_MS = PRESENCE_FRESH_MS;

export type UnavailableAgentState = "not_connected" | "offline" | "not_in_channel";

/** Resolve only explicit @agent addresses to canonical provider names. */
export function explicitlyMentionedAgentKinds(body: string, activeRows: readonly { agent_kind?: string | null }[]): string[] {
  const known = new Set<string>(KNOWN_AGENT_MENTION_NAMES.map((name) => providerMention(name)));
  for (const row of activeRows) {
    if (row.agent_kind) known.add(providerMention(row.agent_kind));
  }
  const mentioned = new Set<string>();
  for (const match of body.matchAll(/@([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)/gi)) {
    const canonical = providerMention(match[1]);
    if (known.has(canonical)) mentioned.add(canonical);
  }
  return [...mentioned];
}

/** Return explicitly named providers that cannot currently consume a message. */
export function unavailableExplicitAgentKinds(
  body: string,
  rows: readonly { agent_kind?: string | null; status?: string | null; last_seen_at?: string | null; is_channel_member?: boolean }[],
  nowMs = Date.now(),
): Array<{ kind: string; state: UnavailableAgentState }> {
  const mentioned = explicitlyMentionedAgentKinds(body, rows);
  type KindStatus = "connected" | "offline" | "not_in_channel";
  // Several connections can share a provider kind. The best one wins regardless of
  // row order: a reachable member beats an offline one, which beats a non-member.
  const rank: Record<KindStatus, number> = { connected: 3, offline: 2, not_in_channel: 1 };
  const statusByKind = new Map<string, KindStatus>();
  const record = (kind: string, status: KindStatus) => {
    const existing = statusByKind.get(kind);
    if (!existing || rank[status] > rank[existing]) statusByKind.set(kind, status);
  };
  for (const row of rows) {
    if (!row.agent_kind || row.status !== "active") continue;
    const kind = providerMention(row.agent_kind);
    if (row.is_channel_member === false) {
      record(kind, "not_in_channel");
      continue;
    }
    const lastSeenMs = row.last_seen_at ? Date.parse(row.last_seen_at) : Number.NaN;
    const recentlySeen = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= RECENT_CONNECTION_MAX_AGE_MS;
    record(kind, recentlySeen ? "connected" : "offline");
  }
  return mentioned.filter((kind) => statusByKind.get(kind) !== "connected").map((kind) => {
    const state = statusByKind.get(kind);
    return {
      kind,
      state: state === "offline" ? "offline" : state === "not_in_channel" ? "not_in_channel" : "not_connected",
    };
  });
}

export function unavailableAgentNoticeBody(entries: readonly { kind: string; state: UnavailableAgentState }[]): string {
  const details = entries
    .map(({ kind, state }) => `${providerLabel(kind)} ${state === "offline" ? "is offline" : state === "not_in_channel" ? "is not a member of this channel" : "is not connected"}`)
    .join(", ");
  return `M9R could not route this message: ${details}. Start or reconnect that provider's M9R Runtime, then send the message again.`;
}

/** Used when the message was saved but the availability query itself failed. */
export function agentAvailabilityUnknownNoticeBody(): string {
  return "M9R saved this message, but could not confirm which connected runtimes can receive it. Check agent connections and retry if no reply appears.";
}

/** Availability diagnostics are informational and must never wake another agent. */
export function isAgentAvailabilityNoticeBody(body: string): boolean {
  return /^(?:M9R could not route this message:|M9R saved this message, but could not confirm|M9R could not start )/i.test(body.trim());
}
