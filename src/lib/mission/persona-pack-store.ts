/** CRUD for persona_packs / persona_pack_assignments. See persona-pack-schema.ts's module comment for scope. */

import { supabase } from "@/lib/supabase";
import { parsePersonaPackManifest, resolvePersonaConfig, type PersonaDefinition, type PersonaPackManifest } from "./persona-pack-schema";

export interface PersonaPackRecord {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  manifest: PersonaPackManifest;
  createdAt: string;
  updatedAt: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

function toRecord(row: { id: string; workspace_id: string; name: string; version: string; manifest: unknown; created_at: string; updated_at: string }): PersonaPackRecord {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, version: row.version, manifest: parsePersonaPackManifest(row.manifest), createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function createPersonaPack(input: { workspaceId: string; manifestInput: unknown; createdByUserId: string | null }): Promise<PersonaPackRecord> {
  const manifest = parsePersonaPackManifest(input.manifestInput);
  const db = requireService();
  const { data, error } = await db.from("persona_packs").insert({
    workspace_id: input.workspaceId, name: manifest.name, version: manifest.version, manifest, created_by_user_id: input.createdByUserId,
  }).select("id, workspace_id, name, version, manifest, created_at, updated_at").single();
  if (error || !data) throw new Error(`Could not save the persona pack: ${error?.message ?? "unknown error"}`);
  return toRecord(data);
}

export async function listPersonaPacks(workspaceId: string): Promise<PersonaPackRecord[]> {
  const db = requireService();
  const { data, error } = await db.from("persona_packs").select("id, workspace_id, name, version, manifest, created_at, updated_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load persona packs: ${error.message}`);
  return (data ?? []).map(toRecord);
}

export async function deletePersonaPack(id: string, workspaceId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("persona_packs").delete().eq("id", id).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not delete the persona pack: ${error.message}`);
}

export async function assignPersonaToAgentKind(input: { workspaceId: string; agentKind: string; packId: string; personaName: string; assignedByUserId: string | null }): Promise<PersonaDefinition> {
  const db = requireService();
  const { data: packRow, error: packError } = await db.from("persona_packs").select("manifest").eq("id", input.packId).eq("workspace_id", input.workspaceId).maybeSingle();
  if (packError || !packRow) throw new Error("Persona pack was not found in this workspace.");
  const manifest = parsePersonaPackManifest(packRow.manifest);
  const resolved = resolvePersonaConfig(manifest, input.personaName); // throws PersonaPackError if the persona name doesn't exist in this pack — fail before persisting a dangling assignment.

  const { error } = await db.from("persona_pack_assignments").upsert({
    workspace_id: input.workspaceId, agent_kind: input.agentKind, pack_id: input.packId, persona_name: input.personaName,
    assigned_by_user_id: input.assignedByUserId, assigned_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not assign the persona: ${error.message}`);
  return resolved;
}

export async function clearPersonaAssignment(workspaceId: string, agentKind: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("persona_pack_assignments").delete().eq("workspace_id", workspaceId).eq("agent_kind", agentKind);
  if (error) throw new Error(`Could not clear the persona assignment: ${error.message}`);
}

/** The resolved persona currently assigned to an agent kind, or null if none is assigned — the read path a future prompt-injection step would call. */
export async function getAssignedPersona(workspaceId: string, agentKind: string): Promise<PersonaDefinition | null> {
  const db = requireService();
  const { data: assignment, error } = await db.from("persona_pack_assignments").select("pack_id, persona_name").eq("workspace_id", workspaceId).eq("agent_kind", agentKind).maybeSingle();
  if (error) throw new Error(`Could not load the persona assignment: ${error.message}`);
  if (!assignment) return null;
  const { data: packRow, error: packError } = await db.from("persona_packs").select("manifest").eq("id", assignment.pack_id).eq("workspace_id", workspaceId).maybeSingle();
  if (packError || !packRow) return null; // Pack was deleted after assignment — treat as unassigned rather than throwing, since this is a read path other code calls best-effort.
  const manifest = parsePersonaPackManifest(packRow.manifest);
  return resolvePersonaConfig(manifest, assignment.persona_name as string);
}
