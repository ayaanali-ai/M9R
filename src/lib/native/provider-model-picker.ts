import type { ManagedProviderConnectionSnapshot } from "./managed-provider-contract";
import type { ProviderModelCapabilities, ProviderModelOption } from "./provider-model-core";

/** The small, provider-neutral view model consumed by the pill. */
export type ProviderModelAvailability = "available" | "not_connected" | "catalog_unavailable";

export interface ProviderModelUiAgent {
  readonly handle: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly availability: ProviderModelAvailability;
  readonly models: readonly ProviderModelOption[];
  readonly currentModel: string | null;
  readonly currentEffort: string | null;
  readonly status: ManagedProviderConnectionSnapshot["status"];
}

export interface ProviderModelUiState {
  readonly agents: readonly ProviderModelUiAgent[];
}

/**
 * Project live capability records into a bounded UI shape. This function never
 * supplies a fallback catalog: `models: null` remains `catalog_unavailable`.
 */
export function providerModelUiState(
  capabilities: readonly ProviderModelCapabilities[],
  snapshots: readonly ManagedProviderConnectionSnapshot[],
): ProviderModelUiState {
  const byConnection = new Map(snapshots.map((snapshot) => [snapshot.connectionId, snapshot]));
  return {
    agents: capabilities.map((capability) => {
      const snapshot = byConnection.get(capability.connectionId);
      const models = capability.models ?? [];
      return {
        handle: snapshot?.handle ?? capability.connectionId,
        provider: capability.provider,
        connectionId: capability.connectionId,
        generation: capability.generation,
        availability: snapshot && snapshot.status !== "stopped" && snapshot.status !== "failed"
          ? capability.models ? "available" : "catalog_unavailable"
          : "not_connected",
        models,
        currentModel: capability.currentModel ?? null,
        currentEffort: capability.currentEffort ?? null,
        status: snapshot?.status ?? "stopped",
      };
    }),
  };
}

