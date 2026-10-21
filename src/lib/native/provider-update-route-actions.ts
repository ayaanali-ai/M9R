import { existsSync } from "node:fs";
import {
  isPackagedMcpExecutable,
  resolveMcpRuntimeExecutable,
} from "./mcp-runtime-path";
import { readRuntimeBuildIdentity } from "./runtime-build-identity";
import type { ProviderUpdateActions } from "./provider-update-lifecycle-core";

export interface ProviderUpdateRouteOptions {
  env?: Record<string, string | undefined>;
  execPath?: string;
  platform?: NodeJS.Platform;
}

function currentMcpRoute(options: ProviderUpdateRouteOptions): string {
  return resolveMcpRuntimeExecutable(
    options.env ?? process.env,
    options.execPath ?? process.execPath,
    options.platform ?? process.platform,
  );
}

/**
 * Actions for the provider-neutral path. Provider binaries and credentials
 * remain outside M9R's ownership. A provider update therefore refreshes no
 * vendor config; it only verifies that the stable M9R MCP route still points
 * at a usable current runtime. The private MCP supervisor owns worker
 * replacement separately and will refresh an idle worker when its build
 * generation changes.
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
    refreshAdapter: () => { verifyRoute(); },
    reconnect: () => {
      try {
        const route = verifyRoute();
        return { healthy: true, detail: `stable M9R MCP route verified at ${route}` };
      } catch (error) {
        return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
