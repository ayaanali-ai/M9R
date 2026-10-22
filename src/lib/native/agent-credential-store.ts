/**
 * User-scoped storage for M9R agent bearer credentials.
 *
 * A provider connection token authorizes one M9R workspace. It must never be
 * discovered from the repository that an agent happens to be working in: a
 * second local account, a copied checkout, or a tool with repository access
 * could otherwise inherit it. The repository still owns non-secret adapter,
 * run, and workspace metadata; this module owns only the bearer credential.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defaultStoreRoot } from "./local-store";

const PROVIDER_SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
const MIGRATION_MARKER = "m9r-user-scoped-credential-v1";

export interface AgentCredentialFile {
  token: string;
  scopes?: string[];
  claim_id?: string;
  saved_at?: string;
  /** Non-secret marker used only when a legacy project file has been neutralized. */
  migrated_from?: string;
  migration?: typeof MIGRATION_MARKER;
}

export interface CredentialMigrationResult {
  provider: string;
  action: "none" | "moved" | "neutralized" | "conflict" | "invalid";
  legacyPath: string;
  credentialPath: string;
}

export interface CredentialProtectionOptions {
  platform?: NodeJS.Platform;
  username?: string;
  run?: (args: string[]) => void;
}

function assertProvider(provider: string): void {
  if (!PROVIDER_SLUG.test(provider)) throw new Error("Provider identity is invalid.");
}

function normalizeRepositoryRoot(repositoryRoot: string): string {
  const resolved = resolve(repositoryRoot);
  const normalized = resolved.split(sep).join("/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Stable opaque key: it does not expose the repository path in the user store. */
export function workspaceCredentialKey(repositoryRoot: string): string {
  return createHash("sha256").update(normalizeRepositoryRoot(repositoryRoot), "utf8").digest("hex").slice(0, 32);
}

function pathIsInside(child: string, parent: string): boolean {
  const remainder = relative(resolve(parent), resolve(child));
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(remainder));
}

/**
 * Return the only authoritative credential directory for this workspace.
 * M9R_HOME remains supported, but a project-local override is rejected rather
 * than silently recreating the old repository-token boundary.
 */
export function agentCredentialRoot(
  repositoryRoot: string,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const root = defaultStoreRoot(home, env);
  if (pathIsInside(root, repositoryRoot)) {
    throw new Error("M9R_HOME must be outside the project workspace; provider credentials cannot be project-local.");
  }
  return join(root, "workspaces", workspaceCredentialKey(repositoryRoot));
}

export function agentCredentialPath(root: string, provider: string): string {
  assertProvider(provider);
  return join(root, "agents", provider, "local.json");
}

export function legacyAgentCredentialPath(repositoryRoot: string, provider: string): string {
  assertProvider(provider);
  return join(resolve(repositoryRoot), ".m9r", "agents", provider, "local.json");
}

function legacyRevokedAgentCredentialPath(repositoryRoot: string, provider: string): string {
  assertProvider(provider);
  return join(resolve(repositoryRoot), ".m9r", "agents", provider, "local.revoked.json");
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * POSIX mode bits do not protect files on Windows. Keep the credential file
 * owner-readable/writable only, and fail closed if Windows refuses the ACL.
 * The user identity is granted explicitly; no blanket Users/Everyone grant is
 * recreated. This is deliberately scoped to bearer credential files, not the
 * repository's non-secret runtime metadata.
 */
export function protectAgentCredentialFile(path: string, options: CredentialProtectionOptions = {}): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  const username = (options.username ?? process.env.USERNAME)?.trim();
  if (!username) throw new Error("The current Windows user is unavailable; refusing to store an M9R provider credential.");
  const run = options.run ?? ((args: string[]) => { execFileSync("icacls.exe", args, { windowsHide: true, stdio: "ignore" }); });
  try {
    run([path, "/inheritance:r"]);
    // Full control is still owner-only, and is required for rotation,
    // revocation, and safe cleanup of the credential file itself.
    run([path, "/grant:r", `${username}:(F)`]);
  } catch {
    throw new Error("Windows refused the owner-only ACL for the M9R provider credential; the credential was not activated.");
  }
}

function parseCredential(raw: string): AgentCredentialFile | null {
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<AgentCredentialFile>;
    if (typeof value.token !== "string" || value.token.trim().length < 16 || value.token.length > 500) return null;
    return { ...value, token: value.token.trim() } as AgentCredentialFile;
  } catch {
    return null;
  }
}

function isNeutralizedMarker(raw: string): boolean {
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return value.migration === MIGRATION_MARKER && !("token" in value);
  } catch {
    return false;
  }
}

export async function readAgentCredential(repositoryRoot: string, provider: string, env: Record<string, string | undefined> = process.env, protection?: CredentialProtectionOptions): Promise<AgentCredentialFile | null> {
  const path = agentCredentialPath(agentCredentialRoot(repositoryRoot, env), provider);
  if (!(await regularFile(path))) return null;
  protectAgentCredentialFile(path, protection);
  return parseCredential(await readFile(path, "utf8"));
}

/**
 * Retire a known revoked credential without retaining its bearer value.
 * Returns false for a missing or already-neutralized file and refuses to
 * overwrite an unrecognized file.
 */
export async function retireAgentCredentialFile(path: string, provider: string, protection?: CredentialProtectionOptions): Promise<boolean> {
  assertProvider(provider);
  if (!(await regularFile(path))) return false;
  const raw = await readFile(path, "utf8");
  if (!parseCredential(raw)) return false;
  await writeFile(path, JSON.stringify({
    migration: MIGRATION_MARKER,
    retired: "revoked",
    provider,
  }) + "\n", "utf8");
  protectAgentCredentialFile(path, protection);
  return true;
}

export async function listConnectedAgentProviders(repositoryRoot: string, env: Record<string, string | undefined> = process.env, protection?: CredentialProtectionOptions): Promise<string[]> {
  const directory = join(agentCredentialRoot(repositoryRoot, env), "agents");
  const names = await readdir(directory).catch(() => [] as string[]);
  const result: string[] = [];
  for (const provider of names.sort()) {
    if (!PROVIDER_SLUG.test(provider)) continue;
    if (await readAgentCredential(repositoryRoot, provider, env, protection)) result.push(provider);
  }
  return result;
}

async function neutralizeLegacyFile(legacyPath: string, repositoryRoot: string, sourceLabel: string): Promise<void> {
  // The token has already been verified in the user-scoped destination. Replace
  // the project file with a non-secret marker instead of leaving a second bearer
  // copy or deleting an unknown file blindly.
  await writeFile(legacyPath, JSON.stringify({ migration: MIGRATION_MARKER, migrated_from: `${resolve(repositoryRoot)}/${sourceLabel}` }) + "\n", { encoding: "utf8", mode: 0o600 });
}

/** Remove the bearer value from a known, already-revoked legacy artifact. */
async function neutralizeLegacyRevokedCredential(repositoryRoot: string, provider: string): Promise<void> {
  const path = legacyRevokedAgentCredentialPath(repositoryRoot, provider);
  if (!(await regularFile(path))) return;
  const raw = await readFile(path, "utf8");
  if (isNeutralizedMarker(raw)) return;
  if (!parseCredential(raw)) {
    throw new Error(`The revoked ${provider} credential file is not a valid M9R credential; refusing to overwrite it.`);
  }
  await neutralizeLegacyFile(path, repositoryRoot, `${provider}/local.revoked.json`);
}

/**
 * Move one legacy repository credential into the user-scoped store. The move
 * is idempotent and fails closed on a destination conflict. Existing files are
 * never overwritten unless their token is byte-for-byte the same credential.
 */
export async function migrateLegacyAgentCredential(
  repositoryRoot: string,
  provider: string,
  env: Record<string, string | undefined> = process.env,
  protection?: CredentialProtectionOptions,
): Promise<CredentialMigrationResult> {
  const legacyPath = legacyAgentCredentialPath(repositoryRoot, provider);
  const credentialPath = agentCredentialPath(agentCredentialRoot(repositoryRoot, env), provider);
  if (!(await regularFile(legacyPath))) return { provider, action: "none", legacyPath, credentialPath };
  const legacyRaw = await readFile(legacyPath, "utf8");
  if (isNeutralizedMarker(legacyRaw)) return { provider, action: "neutralized", legacyPath, credentialPath };
  const legacy = parseCredential(legacyRaw);
  if (!legacy) return { provider, action: "invalid", legacyPath, credentialPath };

  await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
  if (await regularFile(credentialPath)) {
    const current = parseCredential(await readFile(credentialPath, "utf8"));
    if (!current || current.token !== legacy.token) {
      return { provider, action: "conflict", legacyPath, credentialPath };
    }
    protectAgentCredentialFile(credentialPath, protection);
    await neutralizeLegacyFile(legacyPath, repositoryRoot, provider);
    return { provider, action: "neutralized", legacyPath, credentialPath };
  }

  try {
    await rename(legacyPath, credentialPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EACCES" && code !== "EPERM") throw error;
    // Cross-volume or ACL-restricted moves use a verified copy, then replace
    // the source with the marker. No source is removed before the destination
    // can be parsed and matched to the original token.
    await writeFile(credentialPath, JSON.stringify(legacy, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    const copied = parseCredential(await readFile(credentialPath, "utf8"));
    if (!copied || copied.token !== legacy.token) throw new Error(`Credential migration verification failed for ${provider}.`);
    try {
      protectAgentCredentialFile(credentialPath, protection);
    } catch (error) {
      try { await unlink(credentialPath); } catch { /* preserve the security failure */ }
      throw error;
    }
    await neutralizeLegacyFile(legacyPath, repositoryRoot, provider);
    return { provider, action: "moved", legacyPath, credentialPath };
  }

  const moved = parseCredential(await readFile(credentialPath, "utf8"));
  if (!moved || moved.token !== legacy.token) throw new Error(`Credential migration verification failed for ${provider}.`);
  try {
    protectAgentCredentialFile(credentialPath, protection);
  } catch (error) {
    // Restore the legacy source when the destination cannot be secured. This
    // leaves the user with the original credential rather than an exposed new
    // copy, and the next startup can retry the migration safely.
    try { await rename(credentialPath, legacyPath); } catch { /* preserve the security failure */ }
    throw error;
  }
  return { provider, action: "moved", legacyPath, credentialPath };
}

export async function migrateLegacyAgentCredentials(
  repositoryRoot: string,
  env: Record<string, string | undefined> = process.env,
  providers: readonly string[] = ["claude-code", "codex", "opencode", "grok-build"],
  protection?: CredentialProtectionOptions,
): Promise<CredentialMigrationResult[]> {
  const legacyDirectory = join(resolve(repositoryRoot), ".m9r", "agents");
  const discovered = await readdir(legacyDirectory).catch(() => [] as string[]);
  const all = [...new Set([...providers, ...discovered])].filter((provider) => PROVIDER_SLUG.test(provider));
  const results: CredentialMigrationResult[] = [];
  for (const provider of all) {
    results.push(await migrateLegacyAgentCredential(repositoryRoot, provider, env, protection));
    await neutralizeLegacyRevokedCredential(repositoryRoot, provider);
  }
  return results;
}
