import type { SupabaseClient } from "@supabase/supabase-js";

export interface MissionGitSigningIdentity {
  missionId: string;
  participantId: string;
  publicKey: string;
  fingerprint: string;
  registeredAt: string;
}

export interface MissionGitSigningIdentityStore {
  register(input: { workspaceId: string; missionId: string; participantId: string; publicKey: string; fingerprint: string }): Promise<MissionGitSigningIdentity>;
  list(input: { workspaceId: string; missionId: string }): Promise<MissionGitSigningIdentity[]>;
}

export class SupabaseMissionGitSigningIdentityStore implements MissionGitSigningIdentityStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async register(input: { workspaceId: string; missionId: string; participantId: string; publicKey: string; fingerprint: string }): Promise<MissionGitSigningIdentity> {
    const { data, error } = await this.client
      .from("mission_git_signing_identities")
      .upsert(
        { workspace_id: input.workspaceId, mission_id: input.missionId, participant_id: input.participantId, public_key: input.publicKey, fingerprint: input.fingerprint },
        { onConflict: "mission_id,participant_id" },
      )
      .select("mission_id, participant_id, public_key, fingerprint, registered_at")
      .single();
    if (error) throw new Error(`Failed to register Git signing identity: ${error.message}`);
    return fromRow(data as Record<string, unknown>);
  }

  async list(input: { workspaceId: string; missionId: string }): Promise<MissionGitSigningIdentity[]> {
    const { data, error } = await this.client
      .from("mission_git_signing_identities")
      .select("mission_id, participant_id, public_key, fingerprint, registered_at")
      .eq("workspace_id", input.workspaceId)
      .eq("mission_id", input.missionId);
    if (error) throw new Error(`Failed to list Git signing identities: ${error.message}`);
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }
}

function fromRow(row: Record<string, unknown>): MissionGitSigningIdentity {
  return {
    missionId: String(row.mission_id),
    participantId: String(row.participant_id),
    publicKey: String(row.public_key),
    fingerprint: String(row.fingerprint),
    registeredAt: String(row.registered_at),
  };
}

export function createSupabaseMissionGitSigningIdentityStore(client: SupabaseClient): SupabaseMissionGitSigningIdentityStore {
  return new SupabaseMissionGitSigningIdentityStore(client);
}
