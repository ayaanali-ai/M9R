import { providerLabel, providerMention } from "@/lib/provider-adapter-config";

const KNOWN_AGENT_MENTION_NAMES = ["claude", "claude-code", "codex", "opencode", "grok", "grok-build"] as const;

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
  rows: readonly { agent_kind?: string | null; status?: string | null; last_seen_at?: string | null }[],
  nowMs = Date.now(),
): Array<{ kind: string; state: "not_connected" | "offline" }> {
  const mentioned = explicitlyMentionedAgentKinds(body, rows);
  const statusByKind = new Map<string, "connected" | "offline">();
  for (const row of rows) {
    if (!row.agent_kind || row.status !== "active") continue;
    const kind = providerMention(row.agent_kind);
    const lastSeenMs = row.last_seen_at ? Date.parse(row.last_seen_at) : Number.NaN;
    const recentlySeen = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= 90_000;
    statusByKind.set(kind, recentlySeen ? "connected" : "offline");
  }
  return mentioned.filter((kind) => statusByKind.get(kind) !== "connected").map((kind) => {
    const state = statusByKind.get(kind);
    return { kind, state: state === "offline" ? ("offline" as const) : ("not_connected" as const) };
  });
}

export function unavailableAgentNoticeBody(entries: readonly { kind: string; state: "not_connected" | "offline" }[]): string {
  const details = entries
    .map(({ kind, state }) => `${providerLabel(kind)} ${state === "offline" ? "is offline" : "is not connected"}`)
    .join(", ");
  return `M9R could not route this message: ${details}. Start or reconnect that provider's M9R Runtime, then send the message again.`;
}
