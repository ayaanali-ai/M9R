import { existsSync } from "node:fs";
import {
  isPackagedMcpExecutable,
  resolveMcpRuntimeExecutable,
} from "./mcp-runtime-path";
import { readRuntimeBuildIdentity } from "./runtime-build-identity";
import type { ProviderUpdateActions } from "./provider-update-lifecycle-core";
import type { ProviderReconciliationPlan, ProviderRuntimeComparison, ProviderRuntimeObservation } from "./provider-update-compatibility-core";

export interface ProviderConfigRefreshInput {
  providerId: string;
  previous: ProviderRuntimeObservation | null;
  current: ProviderRuntimeObservation;
  comparison: ProviderRuntimeComparison;
  plan: ProviderReconciliationPlan;
  /** The verified stable M9R MCP route; provider adapters may reuse it without discovering another binary. */
  route: string;
}

export interface ProviderUpdateRouteOptions {
  env?: Record<string, string | undefined>;
  execPath?: string;
  platform?: NodeJS.Platform;
  /** Optional provider-specific config/schema reconciliation behind a provider-neutral boundary. */
  refreshProviderConfig?: (input: ProviderConfigRefreshInput) => Promise<void> | void;
  /** Must observe and bind exact live provider sessions; route health is not session health. */
  reconcileProviderSession?: ProviderUpdateActions["reconnect"];
}

function currentMcpRoute(options: ProviderUpdateRouteOptions): string {
  return resolveMcpRuntimeExecutable(
    options.env ?? process.env,
    options.execPath ?? process.execPath,
    options.platform ?? process.platform,
  );
}

/**
 * Provider-neutral update actions. Route verification is a prerequisite, not
 * proof of provider connectivity. A successful reconnect requires the live
 * provider-session reconciler to observe and bind the exact session(s).
 */
export function createProviderNeutralUpdateActions(options: ProviderUpdateRouteOptions = {}): ProviderUpdateActions {
  const verifyRoute = (): string => {
    const route = currentMcpRoute(options);
    if (!existsSync(route)) throw new Error(`M9R MCP route is missing at ${route}`);
    if (isPackagedMcpExecutable(route)) {
      const identity = readRuntimeBuildIdentity(route);
      if (identity.status !== "verified") {
        throw new Error(`M9R MCP runtime is not verified (${identity.reason ?? identity.status})`);
      }
    }
    return route;
  };

  return {
    refreshAdapter: async (input) => {
      const route = verifyRoute();
      await options.refreshProviderConfig?.({ ...input, route });
    },
    reconnect: async (input) => {
      let route: string;
      try {
        route = verifyRoute();
      } catch (error) {
        return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
      }
      if (!options.reconcileProviderSession) {
        return { healthy: false, detail: `M9R route verified at ${route}, but no live provider-session reconciler is configured.` };
      }
      try {
        const result = await options.reconcileProviderSession(input);
        return {
          healthy: result.healthy,
          detail: `M9R route verified; ${result.detail ?? (result.healthy ? "provider session rebound" : "no live provider session was rebound")}`,
        };
      } catch (error) {
        return { healthy: false, detail: `M9R route verified, but provider-session reconciliation failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
