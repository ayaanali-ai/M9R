/**
 * Projects (Workspaces) Service — OathLock
 * ----------------------------------------------------------------------------
 * Read/create operations for a user's projects, which OathLock surfaces as
 * "workspaces". Runs as the signed-in user (cookie session) so RLS applies and
 * ownership is correct.
 *
 * The "active" workspace is a UI/session concept stored in a cookie
 * (see lib/active-project), not a DB column — switching is instant and
 * per-browser without a schema change.
 */

import { createClient } from "@/lib/supabase/server";
import { supabase as admin } from "@/lib/supabase";
import { getActiveProjectId } from "@/lib/active-project";
import {
  assertCanCreateWorkspace,
  getWorkspacePlanUsage,
  type WorkspacePlanUsage,
} from "@/lib/plan-limits-service";

export class ProjectsServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ProjectsServiceError";
    this.code = code;
    this.status = status;
  }
}

export interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
};

function mapRow(row: ProjectRow): ProjectItem {
  return { id: row.id, name: row.name, description: row.description, createdAt: row.created_at };
}

type UserDb = NonNullable<Awaited<ReturnType<typeof createClient>>>;
type AuthedUser = { id: string; email?: string | null; name?: string | null; username?: string | null };

async function requireUserDb() {
  const db = await createClient();
  if (!db) throw new ProjectsServiceError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new ProjectsServiceError("Sign in to manage workspaces.", "UNAUTHENTICATED", 401);
  return {
    db,
    userId: user.id,
    user: {
      id: user.id,
      email: user.email,
      name: (user.user_metadata?.name as string | undefined) ?? null,
      username: (user.user_metadata?.username as string | undefined) ?? null,
    } as AuthedUser,
  };
}

/**
 * Make sure a `public.users` row exists for this auth user.
 *
 * `projects.owner_id` (and `rules.created_by`) reference `public.users(id)`, so
 * inserting a workspace fails with a foreign-key violation when that row is
 * missing — which happens for users created before the auth trigger existed, or
 * if the trigger ever failed.
 *
 * CRITICAL: `public.users` has no INSERT RLS policy/grant for `authenticated`,
 * so the user's own cookie session can NOT create this row. We therefore use the
 * **service-role admin client** (which bypasses RLS) to upsert it. We only fall
 * back to the user session as a last resort. If the row genuinely cannot be
 * ensured, we throw so callers surface a clear error instead of later hitting an
 * opaque foreign-key violation.
 */
export async function ensureUserRow(db: UserDb, user: AuthedUser): Promise<void> {
  const payload = {
    id: user.id,
    auth_user_id: user.id,
    email: user.email ?? "",
    name: user.name ?? null,
    username: user.username ?? null,
  };

  // Preferred path: service role bypasses RLS and reliably creates the row.
  if (admin) {
    const { error } = await admin.from("users").upsert(payload, { onConflict: "id" });
    if (!error) return;
    console.error("ensureUserRow (admin) failed:", error.message, error.code);
    // fall through to the user-session attempt / existence check below
  }

  // Fallback: try as the user (works only if an INSERT policy was added).
  const { error: userErr } = await db.from("users").upsert(payload, { onConflict: "id" });
  if (!userErr) return;

  // Last resort: the upsert was blocked — but the row may already exist, in
  // which case we're fine. Confirm before deciding this is fatal.
  const { data: existing } = await db.from("users").select("id").eq("id", user.id).maybeSingle();
  if (existing?.id) return;

  console.error("ensureUserRow could not ensure user row:", userErr.message, userErr.code);
  throw new ProjectsServiceError(
    "Could not initialize your account. Please try again.",
    "USER_PROVISION_FAILED",
    500,
  );
}

/**
 * Create the user's "Default workspace" and return its id. Uses the service-role
 * admin client when available (so it can't be blocked by RLS), falling back to
 * the user session. Centralised so signup-time provisioning, lazy creation, and
 * the Settings "Ensure Default Workspace" action all behave identically.
 */
/** Every workspace's owner also gets an 'owner' workspace_members row, so
 * they appear on their own Team roster and is_workspace_member() (used
 * throughout RLS) stays the single source of truth going forward instead
 * of two parallel "am I allowed here" checks. Best-effort: a failure here
 * must never block workspace creation itself, since owner_id access still
 * works without it. */
async function seedOwnerMembership(workspaceId: string, userId: string): Promise<void> {
  if (!admin) return;
  const { error } = await admin
    .from("workspace_members")
    .upsert({ workspace_id: workspaceId, user_id: userId, role: "owner" }, { onConflict: "workspace_id,user_id" });
  if (error) console.error("seedOwnerMembership failed:", error.message, error.code);
}

/**
 * Atomically resolves-or-creates the caller's default workspace via
 * m9r_ensure_default_workspace (an advisory-lock-guarded SQL function) --
 * never a plain check-then-insert. Two concurrent callers for the same
 * brand-new user (normal on a dashboard page load with parallel server
 * components) used to be able to both see "no workspace yet" and both
 * insert one, confirmed live via a real duplicate pair created 292ms
 * apart. The lock serializes that race at the database level so only one
 * workspace is ever created per owner, regardless of how many requests
 * ask for it at once.
 */
async function createDefaultWorkspace(db: UserDb, userId: string): Promise<string> {
  await assertCanCreateWorkspace(db, userId);
  const svc = admin ?? db;
  const { data, error } = await svc.rpc("m9r_ensure_default_workspace", { p_owner_id: userId });
  if (error || !data) {
    console.error("createDefaultWorkspace failed:", error?.message, error?.code);
    throw new ProjectsServiceError(
      "Could not resolve a workspace for the rule.",
      "NO_PROJECT",
      500,
    );
  }
  const row = (Array.isArray(data) ? data[0] : data) as { id: string };
  return row.id;
}

/**
 * Resolve the workspace a new rule/trace should belong to, creating a
 * "Default workspace" the first time if the user has none. Preference order:
 *   1. the user's active workspace (cookie) — if they still own it,
 *   2. their oldest existing workspace,
 *   3. a freshly created "Default workspace".
 *
 * This is the single source of truth shared by rule creation, so rules always
 * land in the workspace the user is actually looking at — and it can never
 * dead-end, because step 3 always produces a workspace.
 */
export async function resolveActiveOrDefaultProjectId(
  db: UserDb,
  user: AuthedUser,
): Promise<string> {
  // The FK target must exist before we can insert a project that points at it.
  // This throws on hard failure, so we never proceed into an FK violation.
  await ensureUserRow(db, user);

  // 1. Honour the active-workspace cookie when it points at a workspace we can
  // access -- own it, or be a member of it (projects SELECT RLS already
  // allows both, so this plain select proves access either way).
  const activeId = await getActiveProjectId();
  if (activeId) {
    const { data: accessible, error: activeError } = await db
      .from("projects")
      .select("id")
      .eq("id", activeId)
      .is("deleted_at", null)
      .maybeSingle();
    if (activeError) {
      throw new ProjectsServiceError("Failed to verify the active workspace.", "ACTIVE_PROJECT_LOOKUP_FAILED", 500);
    }
    if (accessible?.id) return accessible.id as string;
    // Active id is stale (deleted/no longer accessible) — fall through.
  }

  // 2. Fall back to the oldest workspace we own.
  const { data: existing, error: existingError } = await db
    .from("projects")
    .select("id")
    .eq("owner_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new ProjectsServiceError("Failed to resolve an existing workspace.", "PROJECT_LOOKUP_FAILED", 500);
  }
  if (existing?.id) return existing.id as string;

  // 2b. We own nothing, but may have been invited into someone else's
  // workspace as a member -- prefer that over silently creating a brand new,
  // empty workspace nobody asked for.
  const { data: memberships, error: membershipError } = await db
    .from("workspace_members")
    .select("workspace_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membershipError && memberships?.workspace_id) return memberships.workspace_id as string;

  // 3. Nothing yet — create the default workspace on first use.
  return createDefaultWorkspace(db, user.id);
}

/**
 * Idempotently guarantee the signed-in user has at least one workspace, creating
 * a "Default workspace" if they have none. Backs the Settings "Ensure Default
 * Workspace" button — a one-click repair for accounts provisioned before the
 * signup trigger was fixed. Returns the workspace that is now guaranteed to
 * exist (existing default, or the newly created one).
 */
export async function ensureDefaultWorkspace(): Promise<ProjectItem> {
  const { db, userId, user } = await requireUserDb();
  await ensureUserRow(db, user);

  const { data: existing, error: existingError } = await db
    .from("projects")
    .select(COLUMNS)
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new ProjectsServiceError("Failed to resolve an existing workspace.", "PROJECT_LOOKUP_FAILED", 500);
  }
  if (existing) return mapRow(existing as ProjectRow);

  const id = await createDefaultWorkspace(db, userId);
  const { data: created } = await db.from("projects").select(COLUMNS).eq("id", id).maybeSingle();
  // created should always be readable by the owner under RLS; map defensively.
  return created
    ? mapRow(created as ProjectRow)
    : { id, name: "Default workspace", description: null, createdAt: new Date().toISOString() };
}

const COLUMNS = "id, name, description, created_at";

/** List every workspace the signed-in user can access -- owned or joined as
 * a member -- oldest first (an owned default workspace is still first for
 * anyone who has one, since ownership predates any invite they'd accept). */
export async function listProjects(): Promise<ProjectItem[]> {
  const { db } = await requireUserDb();
  const { data, error } = await db
    .from("projects")
    .select(COLUMNS)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("listProjects failed:", error.message);
    throw new ProjectsServiceError("Failed to list workspaces.", "LIST_FAILED", 500);
  }
  return (data ?? []).map((r) => mapRow(r as ProjectRow));
}

/** Current signed-in user's plan and active workspace usage. */
export async function getCurrentWorkspacePlanUsage(): Promise<WorkspacePlanUsage> {
  const { db, userId } = await requireUserDb();
  return getWorkspacePlanUsage(db, userId);
}

/** Create a new workspace owned by the signed-in user. */
export async function createProject(name: string, description?: string): Promise<ProjectItem> {
  if (!name?.trim()) throw new ProjectsServiceError("Workspace name is required.", "BAD_INPUT", 400);
  const { db, userId, user } = await requireUserDb();

  // Guarantee the FK target (public.users row) exists before inserting, so the
  // workspace insert can't fail with a foreign-key violation.
  await ensureUserRow(db, user);
  await assertCanCreateWorkspace(db, userId);

  const insert = { owner_id: userId, name: name.trim(), description: description?.trim() || null };

  // Insert as the user first (RLS-correct, ownership obvious). If that is
  // blocked for any reason, retry with the service-role client so an explicit
  // "Create workspace" action still succeeds.
  let { data, error } = await db.from("projects").insert(insert).select(COLUMNS).single();
  if ((error || !data) && admin) {
    console.error("createProject (user) failed, retrying as admin:", error?.message, error?.code);
    ({ data, error } = await admin.from("projects").insert(insert).select(COLUMNS).single());
  }
  if (error || !data) {
    console.error("createProject failed:", error?.message, error?.code);
    throw new ProjectsServiceError(
      "Failed to create the workspace. Please try again.",
      "CREATE_FAILED",
      500,
    );
  }
  await seedOwnerMembership((data as ProjectRow).id, userId);
  return mapRow(data as ProjectRow);
}

/** The active workspace's current name, for prefilling a rename control. */
export async function activeWorkspaceName(): Promise<string> {
  const { db, user } = await requireUserDb();
  const workspaceId = await resolveActiveOrDefaultProjectId(db, user);
  const { data, error } = await db.from("projects").select("name").eq("id", workspaceId).single();
  if (error || !data) {
    throw new ProjectsServiceError("Failed to read the workspace name.", "READ_FAILED", 500);
  }
  return data.name as string;
}

/** Rename the active workspace. Owner-only -- enforced by projects' own
 * UPDATE RLS policy (owner_id = auth.uid()), not app code, same posture as
 * workspace_identity. */
export async function renameActiveWorkspace(name: string): Promise<ProjectItem> {
  const trimmed = name.trim();
  if (!trimmed) throw new ProjectsServiceError("Workspace name is required.", "BAD_INPUT", 400);
  if (trimmed.length > 100) throw new ProjectsServiceError("Workspace name is too long (100 characters max).", "BAD_INPUT", 400);

  const { db, user } = await requireUserDb();
  const workspaceId = await resolveActiveOrDefaultProjectId(db, user);
  const { data, error } = await db
    .from("projects")
    .update({ name: trimmed })
    .eq("id", workspaceId)
    .select(COLUMNS)
    .single();
  if (error || !data) {
    console.error("renameActiveWorkspace failed:", error?.message, error?.code);
    throw new ProjectsServiceError("Failed to rename the workspace.", "RENAME_FAILED", 500);
  }
  return mapRow(data as ProjectRow);
}

/** Confirm the signed-in user can access a project -- owns it or is a member
 * -- before switching to it. Relies on projects' own SELECT RLS (owner OR
 * membership) rather than re-checking owner_id here, so this stays correct
 * automatically if that policy's definition of access ever changes again. */
export async function userOwnsProject(projectId: string): Promise<boolean> {
  const { db } = await requireUserDb();
  const { data } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  return Boolean(data);
}
