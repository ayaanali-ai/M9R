import { connectionLiveness } from "@/lib/agent-dashboard-presenter";

/**
 * Pure rules for Stage 1 endpoints (M9R_NETWORK_SPEC.md sections 3, 5, 12 as locked in
 * M9R_NETWORK_SPEC_LOCK.md). No database access here so the rules can be tested exhaustively.
 */

export type Fidelity = "LIVE_NATIVE" | "RESUMABLE_NATIVE" | "CONSULTATION";

/** Providers whose bridge adapters M9R hosts and controls. Anything else is only ever a consultation. */
const M9R_HOSTED_PROVIDERS = new Set(["claude-code", "codex", "opencode"]);

export interface EndpointRow {
  id: string;
  workspace_id: string;
  owner_user_id: string | null;
  provider: string;
  alias: string;
  current_connection_id: string | null;
  session_generation: number;
  status: "active" | "suspended" | "retired";
}

export interface EndpointView {
  id: string;
  address: string;
  provider: string;
  alias: string;
  generation: number;
  status: EndpointRow["status"];
  reachability: "live" | "queue" | "offline";
  presence: { state: "idle" | "offline"; confidence: "inferred" | "unknown"; lastSeenAt: string | null };
  fidelity: { level: Fidelity; basis: "m9r_hosted_session" | "no_native_interface"; note: string };
  mine: boolean;
}

/** External form of an endpoint id: `ep_` plus the uuid without dashes. */
export function endpointRef(id: string): string {
  return `ep_${id.replaceAll("-", "")}`;
}

export function parseEndpointRef(value: string): string | null {
  const match = /^ep_([0-9a-f]{32})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ParsedAddress =
  | { kind: "alias"; alias: string }
  | { kind: "id"; id: string }
  | { kind: "handle"; owner: string; name: string; generation: number | null }
  | { kind: "invalid"; reason: string };

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?";
const ALIAS_PATTERN = new RegExp(`^${LABEL}$`);
const HANDLE_PATTERN = new RegExp(`^(${LABEL})/(${LABEL})(?:~([0-9]{1,9}))?$`);

/** Accepts `@codex`, `codex`, `ep_<32 hex>` and the future `@owner/name[~generation]` form. */
export function parseAddress(input: string): ParsedAddress {
  const value = input.trim().replace(/^@/, "").toLowerCase().normalize("NFKC");
  if (!value) return { kind: "invalid", reason: "The address is empty." };
  if (value.startsWith("ep_")) {
    const id = parseEndpointRef(value);
    return id ? { kind: "id", id } : { kind: "invalid", reason: "An endpoint id looks like ep_ followed by 32 hex characters." };
  }
  if (value.includes("/")) {
    const match = HANDLE_PATTERN.exec(value);
    if (!match) return { kind: "invalid", reason: "Addresses look like @owner/name (lowercase letters, digits and hyphens, 2-39 characters each)." };
    return { kind: "handle", owner: match[1], name: match[2], generation: match[3] ? Number(match[3]) : null };
  }
  if (!ALIAS_PATTERN.test(value)) return { kind: "invalid", reason: "That is not a valid agent name (lowercase letters, digits and hyphens)." };
  return { kind: "alias", alias: value };
}

export function fidelityFor(provider: string, bound: boolean): EndpointView["fidelity"] {
  if (M9R_HOSTED_PROVIDERS.has(provider) && bound) {
    return {
      level: "LIVE_NATIVE",
      basis: "m9r_hosted_session",
      note: "M9R runs this session, so it can send, interrupt and approve. A session you start yourself in a plain terminal is not an endpoint yet.",
    };
  }
  return {
    level: "CONSULTATION",
    basis: "no_native_interface",
    note: bound ? "M9R has no live interface to this provider; replies come from a separate helper, not a live session." : "No live session is bound to this endpoint right now.",
  };
}

/**
 * Reachability follows the locked presence rule: a 90 second lease. A bound endpoint that is not fresh is
 * `queue` (messages wait 24 h, D6), never "live". An endpoint with no session bound at all is also `queue`,
 * because the durable address still accepts messages; only suspended or retired endpoints are `offline`.
 */
export function buildEndpointView(row: EndpointRow, lastSeenAt: string | null, viewerOwnerId: string | null, now = Date.now()): EndpointView {
  const bound = row.current_connection_id !== null;
  const fresh = bound && connectionLiveness(lastSeenAt, now) === "active";
  const open = row.status === "active";
  return {
    id: endpointRef(row.id),
    address: `@${row.alias}`,
    provider: row.provider,
    alias: row.alias,
    generation: row.session_generation,
    status: row.status,
    reachability: !open ? "offline" : fresh ? "live" : "queue",
    presence: fresh
      ? { state: "idle", confidence: "inferred", lastSeenAt }
      : { state: "offline", confidence: "unknown", lastSeenAt },
    fidelity: fidelityFor(row.provider, fresh),
    mine: viewerOwnerId !== null && row.owner_user_id === viewerOwnerId,
  };
}

export type ResolveOutcome =
  | { ok: true; endpoint: EndpointRow }
  | { ok: false; code: "ENDPOINT_NOT_FOUND" | "AMBIGUOUS_ENDPOINT" | "INVALID_ADDRESS" | "HANDLES_NOT_AVAILABLE"; message: string; candidates?: string[] };

/**
 * Locked resolution rules (A2): an exact id wins; a bare alias resolves to the caller's own endpoint when that
 * is the only match, otherwise to the only endpoint in the workspace, otherwise it is ambiguous and the
 * candidates are listed. Bare names are never resolved across owners by guessing.
 */
export function resolveAddress(input: string, endpoints: EndpointRow[], viewerOwnerId: string | null): ResolveOutcome {
  const parsed = parseAddress(input);
  if (parsed.kind === "invalid") return { ok: false, code: "INVALID_ADDRESS", message: parsed.reason };
  if (parsed.kind === "handle") {
    return { ok: false, code: "HANDLES_NOT_AVAILABLE", message: "Owner handles (@owner/name) are not available yet. Use the plain agent name, for example @codex." };
  }
  const open = endpoints.filter((endpoint) => endpoint.status !== "retired");
  if (parsed.kind === "id") {
    const found = open.find((endpoint) => endpoint.id === parsed.id);
    return found ? { ok: true, endpoint: found } : { ok: false, code: "ENDPOINT_NOT_FOUND", message: "No endpoint with that id is visible to you." };
  }
  const matches = open.filter((endpoint) => endpoint.alias === parsed.alias);
  if (matches.length === 0) {
    const known = [...new Set(open.map((endpoint) => `@${endpoint.alias}`))].join(", ") || "none";
    return { ok: false, code: "ENDPOINT_NOT_FOUND", message: `No agent named @${parsed.alias} in this workspace. Known agents: ${known}.` };
  }
  if (matches.length === 1) return { ok: true, endpoint: matches[0] };
  const mine = viewerOwnerId ? matches.filter((endpoint) => endpoint.owner_user_id === viewerOwnerId) : [];
  if (mine.length === 1) return { ok: true, endpoint: mine[0] };
  return {
    ok: false,
    code: "AMBIGUOUS_ENDPOINT",
    message: `More than one @${parsed.alias} is connected in this workspace. Use one of the endpoint ids below.`,
    candidates: matches.map((endpoint) => endpointRef(endpoint.id)),
  };
}
