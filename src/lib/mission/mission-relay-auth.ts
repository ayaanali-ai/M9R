export interface MissionRelayPrincipal {
  kind: "human" | "bridge";
  id: string;
  workspaceIds: readonly string[];
}

export type RelayAuthorizationResult =
  | { ok: true }
  | { ok: false; code: "workspace_forbidden"; message: string };

export function authorizeRelayWorkspace(principal: MissionRelayPrincipal, workspaceId: string): RelayAuthorizationResult {
  if (principal.workspaceIds.includes(workspaceId)) return { ok: true };
  return { ok: false, code: "workspace_forbidden", message: "Relay access to this workspace is not authorized." };
}

export interface MissionRelayAuthenticator {
  authenticate(input: { kind: "browser" | "bridge"; credential: string; workspaceId: string }): Promise<MissionRelayPrincipal>;
}
