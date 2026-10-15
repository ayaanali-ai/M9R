import type { NetworkActor } from "./network-actor";

export interface Env {
  NETWORKS: DurableObjectNamespace<NetworkActor>;
  HISTORY: D1Database;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  PAIRING_CODE_PEPPER: string;
}

export type AgentScope = "read" | "write";
export type NetworkRole = "owner" | "member";

export interface AgentCredentialRoute {
  networkId: string;
  agentId: string;
  token: string;
}

export interface HumanIdentity {
  userId: string;
  email: string | null;
}
