/**
 * Item #32: workspace-scoped model-provider API keys for M9R's own
 * first-party any-model harness (the "m9r-native" adapter). This is the one
 * table in the whole build handling a genuine third-party secret -- a
 * user's own Anthropic/OpenAI/Google/etc. API key -- so it goes through
 * Supabase Vault (pgsodium-backed, KMS-managed) via SECURITY DEFINER SQL
 * functions, never a plaintext column. See the migration
 * m9r_native_credential_vault_functions.sql for the actual encryption; this
 * file only ever calls those functions, it never touches key material
 * itself outside of passing it through to `m9r_native_store_credential`.
 *
 * Never expose `getWorkspaceProviderEnv`'s return value to any client --
 * it is real decrypted secret material, service-role read only, used
 * exclusively to build a spawned/in-process request's environment.
 */
import { supabase } from "@/lib/supabase";
import { getModelCatalog } from "@/lib/mission/m9r-native-model-catalog";
import { SUPPORTED_NPM_PACKAGES } from "@/lib/bridge/m9r-native-provider-registry";

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

export type ProviderEnvVar = string;

/**
 * Allowlisted against the real, live catalog -- not a hand-typed list.
 * A fixed short enum can't scale to the 200+ real providers the catalog
 * covers, so this validates a candidate env var name by checking it's
 * actually one a real, *supported* catalog provider declares (supported =
 * its npm package is in `SUPPORTED_NPM_PACKAGES` -- the audited set this
 * harness can actually drive, per m9r-native-provider-registry.ts). This
 * still refuses arbitrary free text: a name that isn't any real, supported
 * provider's actual env var is rejected the same as before, just checked
 * against live data instead of a static list that would need editing every
 * time a provider gets added.
 */
export async function isProviderEnvVar(value: unknown): Promise<boolean> {
  if (typeof value !== "string" || !value.trim()) return false;
  const providers = await getModelCatalog();
  for (const provider of providers.values()) {
    if (!SUPPORTED_NPM_PACKAGES.has(provider.npm)) continue;
    if (provider.env.includes(value)) return true;
  }
  return false;
}

export interface ProviderCredentialMetadata {
  providerEnvVar: ProviderEnvVar;
}

/** Stores (or rotates, if one already exists for this workspace+env var) one credential. Never logs or returns the secret value. */
export async function storeProviderCredential(input: {
  workspaceId: string;
  providerEnvVar: ProviderEnvVar;
  secret: string;
  createdByUserId: string | null;
}): Promise<void> {
  const secret = input.secret.trim();
  if (!secret) throw new Error("A non-empty credential value is required.");
  if (!(await isProviderEnvVar(input.providerEnvVar))) throw new Error(`"${input.providerEnvVar}" isn't a supported provider's credential env var.`);
  const db = requireService();
  const { error } = await db.rpc("m9r_native_store_credential", {
    p_workspace_id: input.workspaceId,
    p_provider_env_var: input.providerEnvVar,
    p_secret: secret,
    p_created_by: input.createdByUserId,
  });
  if (error) throw new Error(`Could not store the credential: ${error.message}`);
}

/** Metadata only -- which providers this workspace has a credential for, never the value. Safe to return to a dashboard. */
export async function listProviderCredentialMetadata(workspaceId: string): Promise<ProviderCredentialMetadata[]> {
  const db = requireService();
  const { data, error } = await db.from("m9r_native_provider_credentials").select("provider_env_var").eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not list credentials: ${error.message}`);
  // Trusted read of this codebase's own prior writes (storeProviderCredential
  // already validated against the catalog before anything landed here) --
  // no need to re-check against a live catalog fetch just to list metadata.
  return (data ?? []).map((row) => ({ providerEnvVar: row.provider_env_var as string }));
}

/**
 * Deliberately does NOT re-validate providerEnvVar against the live catalog
 * -- a workspace must always be able to delete a credential it already
 * stored, even if the catalog is transiently unreachable or a provider's
 * entry changed since the credential was created. Deletion is scoped to
 * (workspaceId, providerEnvVar) and only ever removes a row that already
 * exists, so there's no injection surface here to guard against the way
 * storeProviderCredential's write path has.
 */
export async function deleteProviderCredential(workspaceId: string, providerEnvVar: ProviderEnvVar): Promise<void> {
  const db = requireService();
  const { error } = await db.rpc("m9r_native_delete_credential", { p_workspace_id: workspaceId, p_provider_env_var: providerEnvVar });
  if (error) throw new Error(`Could not delete the credential: ${error.message}`);
}

/**
 * Real decrypted secret material -- service-role read only, used exclusively
 * to build the environment for a real provider request (spawned process env
 * or in-process AI SDK client construction). Never return this to any
 * client, never log it, never include it in an error message.
 */
export async function getWorkspaceProviderEnv(workspaceId: string): Promise<Partial<Record<ProviderEnvVar, string>>> {
  const db = requireService();
  const { data, error } = await db.rpc("m9r_native_get_credentials", { p_workspace_id: workspaceId });
  if (error) throw new Error("Could not load provider credentials.");
  const env: Partial<Record<ProviderEnvVar, string>> = {};
  // Same trusted-read posture as listProviderCredentialMetadata above --
  // these rows only ever got here through the already-validated write path.
  for (const row of (data ?? []) as { provider_env_var: string; decrypted_value: string }[]) {
    env[row.provider_env_var] = row.decrypted_value;
  }
  return env;
}
