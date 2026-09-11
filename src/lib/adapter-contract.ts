/**
 * Generic Adapter Contract — OathLock V2 Gate 3
 * ----------------------------------------------------------------------------
 * Any provider adapter (the `oathlock` CLI wrapping Codex/Claude Code/Grok Build/CI,
 * or a future direct HTTP integration) speaks the same versioned, bounded set
 * of actions. This module is the single source of truth for what those actions
 * are — both for serving a machine-readable manifest to adapters, and for
 * negotiating which actions a specific adapter declares it supports.
 *
 * Negotiation never trusts an adapter's self-declared support for an unknown
 * action: only actions present in KNOWN_ADAPTER_ACTIONS can ever be "supported".
 * This is what keeps an unsupported action from ever being shown as working.
 */

export const ADAPTER_CONTRACT_VERSION = "m9r.adapter-contract.v1" as const;
export const CAPABILITY_MANIFEST_VERSION = "m9r.provider-capabilities.v1" as const;

export interface AdapterAction {
  id: string;
  description: string;
  /** The HTTP route this action corresponds to, for discovery. */
  route: string;
}

export const KNOWN_ADAPTER_ACTIONS: readonly AdapterAction[] = [
  { id: "heartbeat", description: "Report authenticated, workspace-scoped liveness on a server-issued lease.", route: "POST /api/agent/presence/heartbeat" },
  { id: "rules_read", description: "Fetch active, evidence-backed workspace rules.", route: "GET /api/agent/rules" },
  { id: "inbox_read", description: "Pull queued dashboard instructions for this connection.", route: "GET /api/agent/inbox" },
  { id: "assignment_lifecycle", description: "List and explicitly accept, reject, or complete bounded assignments for this connection.", route: "GET /api/agent/assignments, PATCH /api/agent/assignments/:id" },
  { id: "run_lifecycle", description: "Start a run and report phase changes.", route: "POST /api/agent/run/start, POST /api/agent/run/status" },
  { id: "work_signal_emit", description: "Record a versioned, replay-safe Work Signal for this connection.", route: "POST /api/agent/signals" },
  { id: "work_signal_replay", description: "Read Work Signals for this workspace by cursor.", route: "GET /api/agent/signals" },
  { id: "work_signal_ack", description: "Self-acknowledge this connection's own Work Signals through a sequence.", route: "POST /api/agent/signals/ack" },
  { id: "evidence_submit", description: "Submit a session and optional structured Evidence Contract.", route: "POST /api/agent/session" },
  { id: "token_rotation", description: "Rotate this connection's own token without a new human-approved claim.", route: "POST /api/agent/rotate-token" },
] as const;

const KNOWN_ACTION_IDS = new Set(KNOWN_ADAPTER_ACTIONS.map((a) => a.id));

export interface AdapterContractManifest {
  protocolVersion: typeof ADAPTER_CONTRACT_VERSION;
  actions: readonly AdapterAction[];
  capabilityManifestVersion: typeof CAPABILITY_MANIFEST_VERSION;
  providers: readonly ProviderCapabilityManifest[];
  /** Provider-neutral baseline available to every valid agent_kind slug. */
  genericProvider: ProviderCapabilityManifest;
}

export type ProviderVerificationStatus = "implemented_not_live_verified" | "protocol_exchange_verified" | "live_verified";

export interface ProviderCapabilityManifest {
  id: string;
  label: string;
  executionMode: "linked";
  transport: "generic_cli";
  supportedActions: readonly string[];
  verificationStatus: ProviderVerificationStatus;
  liveLifecycleVerified: boolean;
  crossRuntimeExchangeVerified: boolean;
  residentExecutionSupported: boolean;
  executionDisclosure: string;
  limitations: readonly string[];
}

const GENERIC_CLI_ACTIONS = KNOWN_ADAPTER_ACTIONS.map((action) => action.id);

/**
 * Gate 0 truth inventory for provider adapters.
 *
 * These entries describe protocol support in the generic CLI, not a claim that
 * each provider has completed a live end-to-end verification. Promotion to
 * `live_verified` requires a dated, retained proof package from an independent
 * provider process; self-declaration or unit tests are insufficient.
 */
export const PROVIDER_CAPABILITIES: readonly ProviderCapabilityManifest[] = [
  ["codex", "Codex"],
  ["claude-code", "Claude"],
  ["grok-build", "Grok Build"],
  ["other", "Other CLI agent"],
].map(([id, label]) => {
  const protocolExchangeVerified = id === "codex" || id === "claude-code";
  return {
    id: id as ProviderCapabilityManifest["id"],
    label,
    executionMode: "linked" as const,
    transport: "generic_cli" as const,
    supportedActions: GENERIC_CLI_ACTIONS,
    verificationStatus: protocolExchangeVerified ? "protocol_exchange_verified" as const : "implemented_not_live_verified" as const,
    liveLifecycleVerified: false,
    crossRuntimeExchangeVerified: protocolExchangeVerified,
    residentExecutionSupported: false,
    executionDisclosure: `${label} executes outside M9R; the M9R CLI reports authenticated events from its provider environment.`,
    limitations: [
      ...(protocolExchangeVerified
        ? ["A live, persisted Codex-to-Claude protocol exchange was verified on 2026-07-13; this does not prove a complete provider task lifecycle."]
        : ["No live cross-runtime exchange has been retained for this provider."]),
      "A complete live task lifecycle has not yet been retained as a human-observed proof package for this provider.",
      "Protocol support does not prove the provider exposes internal reasoning, token usage, subagents, or every failure state.",
      "M9R does not host or control this linked provider process.",
    ],
  };
});

export const GENERIC_PROVIDER_CAPABILITY: ProviderCapabilityManifest = {
  id: "any-provider",
  label: "Any M9R-connected provider",
  executionMode: "linked",
  transport: "generic_cli",
  supportedActions: GENERIC_CLI_ACTIONS,
  verificationStatus: "implemented_not_live_verified",
  liveLifecycleVerified: false,
  crossRuntimeExchangeVerified: false,
  residentExecutionSupported: false,
  executionDisclosure: "Any provider with a valid M9R connection can use the provider-neutral CLI, inbox, messaging, run, signal, and evidence actions.",
  limitations: [
    "Provider-specific automatic spawning requires a local adapter command that speaks ACP over stdio.",
    "A generic connection never claims provider-internal reasoning, token usage, or tool events that the provider does not report.",
  ],
};

/** The manifest an adapter can fetch to discover what OathLock supports, before or after connecting. */
export function adapterContractManifest(): AdapterContractManifest {
  return {
    protocolVersion: ADAPTER_CONTRACT_VERSION,
    actions: KNOWN_ADAPTER_ACTIONS,
    capabilityManifestVersion: CAPABILITY_MANIFEST_VERSION,
    providers: PROVIDER_CAPABILITIES,
    genericProvider: GENERIC_PROVIDER_CAPABILITY,
  };
}

export interface NegotiationResult {
  supported: string[];
  unsupported: string[];
}

/**
 * Negotiate a set of declared action ids against a known contract (defaults to
 * this module's own KNOWN_ADAPTER_ACTIONS, but callers may pass a different
 * contract — e.g. a manifest fetched live from the server — to detect drift
 * between what an adapter implements and what the server currently supports).
 * Anything not in `known` is reported unsupported: a declaration alone can
 * never grant a capability the other side doesn't recognize.
 */
export function negotiateAdapterActions(declared: unknown, known: readonly AdapterAction[] = KNOWN_ADAPTER_ACTIONS): NegotiationResult {
  const knownIds = known === KNOWN_ADAPTER_ACTIONS ? KNOWN_ACTION_IDS : new Set(known.map((a) => a.id));
  const requested = Array.isArray(declared) ? declared.filter((v): v is string => typeof v === "string") : [];
  const unique = Array.from(new Set(requested));
  const supported = unique.filter((id) => knownIds.has(id));
  const unsupported = unique.filter((id) => !knownIds.has(id));
  return { supported, unsupported };
}
