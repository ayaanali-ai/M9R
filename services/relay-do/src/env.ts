import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import type { WorkspaceHub } from "./hub";

export interface Env {
  HUB: DurableObjectNamespace<WorkspaceHub>;
  /** Service binding to the web app; carries all database and product logic. */
  WEB: Fetcher;
  WEB_RPC_URL: string;
  /** Signs relay tokens AND is the bearer for /internal/* (kept identical to the container Relay for compatibility). */
  MISSION_RELAY_TOKEN_SECRET: string;
  /** Authenticates this Worker to the web app's /api/internal/relay/rpc. */
  RELAY_INTERNAL_SECRET: string;
}
