import type { AdapterContext, ProviderCapabilities, ProviderAssignment, ProviderInvocation } from "@/lib/mission/mission-provider-adapter";
import type { EnvironmentKind } from "@/lib/mission/mission-process-host";

export interface AgentServerHandle {
  serverId: string;
  adapterId: string;
}

export interface AgentServerHealth {
  state: "alive" | "dead" | "unknown";
  detail: string;
}

export interface InitializedAgent {
  protocolVersion: string;
  agentName: string;
  capabilities: InteractiveProviderCapabilities;
}

export interface AgentSessionHandle {
  sessionId: string;
  providerSessionRef: string | null;
  /** Best-effort: this provider's real, live model choices from its own newSession response, when it exposes a "model" config option. Null when the provider doesn't expose one -- never a guessed/hardcoded list. */
  availableModels?: { id: string; label: string }[] | null;
}

export interface InteractiveProviderEvent {
  type: string;
  sessionId: string;
  occurredAt: string;
  /** Added by the session controller so all events from one prompt can be projected once. */
  turnId?: string;
  payload: Record<string, unknown>;
}

export interface InteractiveProviderAdapter {
  readonly id: string;
  discoverCapabilities(ctx: AdapterContext): Promise<InteractiveProviderCapabilities>;
  launchServer(input: { assignment: ProviderAssignment; environment: { workingDirectory: string; kind: EnvironmentKind } }): Promise<AgentServerHandle>;
  getServerHealth?(handle: AgentServerHandle): AgentServerHealth;
  initialize(handle: AgentServerHandle): Promise<InitializedAgent>;
  createSession(input: { server: AgentServerHandle; assignment: ProviderAssignment; executionId?: string }): Promise<AgentSessionHandle>;
  resumeSession(input: { server: AgentServerHandle; providerSessionRef: string; assignment: ProviderAssignment }): Promise<AgentSessionHandle>;
  prompt(input: { session: AgentSessionHandle; text: string }): AsyncIterable<InteractiveProviderEvent>;
  steer?(input: { session: AgentSessionHandle; text: string }): Promise<void>;
  cancelTurn(input: { session: AgentSessionHandle }): Promise<void>;
  respondToPermission(input: { session: AgentSessionHandle; requestId: string; approved: boolean }): Promise<void>;
  closeSession(input: { session: AgentSessionHandle }): Promise<void>;
  shutdown(handle: AgentServerHandle): Promise<void>;
}

export const INTERACTIVE_PROVIDER_CAPABILITIES = [
  "mid_turn_steering",
  "file_event_reporting",
  "command_event_reporting",
  "plan_event_reporting",
  "terminal_event_reporting",
  "permission_event_reporting",
] as const;
export type InteractiveProviderCapability = (typeof INTERACTIVE_PROVIDER_CAPABILITIES)[number];
export type InteractiveProviderCapabilities = ProviderCapabilities & Partial<Record<InteractiveProviderCapability, boolean>>;

export function interactiveCapabilityAvailable(capabilities: Partial<ProviderCapabilities> & Partial<Record<InteractiveProviderCapability, boolean>>, capability: keyof ProviderCapabilities | InteractiveProviderCapability): boolean {
  return capabilities[capability] === true;
}

/** A sibling contract for interactive providers; the one-shot ProviderAdapter remains valid when this is unavailable. */
export interface InteractiveProviderFallback {
  prepareOneShotInvocation(assignment: ProviderAssignment, environment: { workingDirectory: string; kind: EnvironmentKind }): Promise<ProviderInvocation>;
}
