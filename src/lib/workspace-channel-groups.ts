/**
 * The Watchfloor has two kinds of conversation records:
 *
 * - workspace rooms created by the human (including the three core rooms),
 * - agent-created conversations used for bounded handoffs and tests.
 *
 * Keep this classification in one dependency-free module so the server can
 * safely retire stale diagnostics and the client can render the same groups.
 * A user-created channel always has a slug; un-slugged records are the legacy
 * agent conversation shape, which is why we never hide a slugged channel just
 * because its name happens to look like a test name.
 */

export const BUILT_IN_CHANNEL_ORDER = ["general", "agents", "activity"] as const;
export type BuiltInChannelSlug = (typeof BUILT_IN_CHANNEL_ORDER)[number];

export type WorkspaceChannelGroup = "core" | "workspace" | "agent" | "direct" | "diagnostic";

export interface ChannelClassificationInput {
  channelSlug?: string | null;
  channel_slug?: string | null;
  channelKind?: "channel" | "dm" | null;
  channel_kind?: "channel" | "dm" | null;
  topic?: string | null;
}

function normalizedSlug(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Known test/diagnostic topics emitted by the OathLock bridge smoke suites. */
export function isDiagnosticConversation(input: ChannelClassificationInput): boolean {
  const channelKind = input.channelKind ?? input.channel_kind;
  const channelSlug = input.channelSlug ?? input.channel_slug;
  if (channelKind === "dm" || channelSlug) return false;
  const topic = (input.topic ?? "").trim();
  return /^(?:routing(?:[-_\s]|$)|a2a(?:[-_\s]|$)|diagnostic(?:[-_\s]|$)|smoke(?:[-_\s]|$)|test(?:[-_\s:]|$))/i.test(topic);
}

export function channelGroupForConversation(input: ChannelClassificationInput): WorkspaceChannelGroup {
  const channelKind = input.channelKind ?? input.channel_kind;
  const channelSlug = input.channelSlug ?? input.channel_slug;
  if (channelKind === "dm") return "direct";
  const slug = normalizedSlug(channelSlug) || normalizedSlug(input.topic);
  if ((BUILT_IN_CHANNEL_ORDER as readonly string[]).includes(slug)) return "core";
  if (isDiagnosticConversation(input)) return "diagnostic";
  return channelSlug ? "workspace" : "agent";
}

/** The `#channel-name` form shown wherever a conversation is named. Shared so
 * the primary nav and the message feed can never disagree about a channel's
 * displayed name. */
export function channelDisplayName(input: ChannelClassificationInput): string {
  return (input.topic ?? "").toLowerCase().trim().replace(/\s+/g, "-");
}

export function builtInChannelRank(input: ChannelClassificationInput): number {
  const slug = normalizedSlug(input.channelSlug ?? input.channel_slug) || normalizedSlug(input.topic);
  const rank = BUILT_IN_CHANNEL_ORDER.indexOf(slug as BuiltInChannelSlug);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

export const DIAGNOSTIC_INACTIVITY_MS = 24 * 60 * 60 * 1_000;
