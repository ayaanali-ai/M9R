/**
 * Provider adapter registry (Phase 3A)
 * ----------------------------------------------------------------------------
 * Where a `ProviderAdapter` (mission-provider-adapter.ts) is looked up by
 * id, and where capability requirements are checked BEFORE anything is
 * launched. `assertCapabilities` is the one place "unsupported capabilities
 * are rejected before launch" is enforced — a caller that skips it and
 * calls `ProcessExecutionHost.launch` directly gets no such protection,
 * which is why the recommended integration path (see
 * IMPLEMENTATION_NOTES.md) always routes through this registry first.
 */

import type { AdapterContext, ProviderAdapter, ProviderCapabilities, ProviderCapability } from "./mission-provider-adapter";

export interface UnknownAdapterError {
  code: "unknown_adapter";
  adapterId: string;
}

export interface UnsupportedCapabilityError {
  code: "unsupported_capability";
  adapterId: string;
  missing: ProviderCapability[];
}

export type CapabilityCheckError = UnknownAdapterError | UnsupportedCapabilityError;
export type CapabilityCheckResult = { ok: true; capabilities: ProviderCapabilities } | { ok: false; error: CapabilityCheckError };

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): ProviderAdapter | null {
    return this.adapters.get(adapterId) ?? null;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * The pre-launch gate: looks up the adapter, discovers its capabilities
   * (never assumes them from a prior call — a provider's supported feature
   * set is asked for fresh every time, since discovery may itself depend on
   * the environment passed in `context`), and refuses with the SPECIFIC
   * missing capabilities when the requirement isn't fully met. Never
   * launches anything itself.
   */
  async assertCapabilities(adapterId: string, context: AdapterContext, required: readonly ProviderCapability[]): Promise<CapabilityCheckResult> {
    const adapter = this.get(adapterId);
    if (!adapter) return { ok: false, error: { code: "unknown_adapter", adapterId } };

    const capabilities = await adapter.discoverCapabilities(context);
    const missing = required.filter((capability) => capabilities[capability] !== true);

    if (missing.length > 0) {
      return { ok: false, error: { code: "unsupported_capability", adapterId, missing } };
    }
    return { ok: true, capabilities };
  }
}
