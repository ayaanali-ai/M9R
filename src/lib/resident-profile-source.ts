import { join } from "node:path";

export type ResidentAgentKind = string;

const RESIDENT_PROVIDER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function isResidentAgentKind(provider: unknown): provider is string {
  return typeof provider === "string" && RESIDENT_PROVIDER_PATTERN.test(provider);
}

export function residentCredentialPaths(repositoryRoot: string, provider: ResidentAgentKind): string[] {
  if (!isResidentAgentKind(provider)) throw new Error("Provider identity is invalid.");
  return [
    join(repositoryRoot, ".oathlock", "agents", provider, "local.json"),
    join(repositoryRoot, ".oathlock", "local.json"),
  ];
}

/** Injects the current connection credential at runtime; resident config copies are never authoritative. */
export function applyResidentCredential(profile: Record<string, unknown>, local: unknown): Record<string, unknown> {
  const token = local && typeof local === "object" && !Array.isArray(local)
    ? (local as { token?: unknown }).token
    : null;
  if (typeof token !== "string" || token.trim().length < 16 || token.length > 500) {
    throw new Error("Provider connection is unavailable; reconnect this agent with oathlock init.");
  }
  return { ...profile, token: token.trim() };
}

export function refreshResidentProfile(profile: Record<string, unknown>, instanceKey: string): Record<string, unknown> {
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(instanceKey)) throw new Error("Resident instance identity is invalid.");
  const persisted = { ...profile };
  delete persisted.token;
  return { ...persisted, instanceKey, heartbeatSequence: 0 };
}
