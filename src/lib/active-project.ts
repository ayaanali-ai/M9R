/**
 * Active workspace (project) — stored in a cookie so the choice persists across
 * requests without a schema change. Server components read it; the switch route
 * writes it after verifying ownership.
 */

import { cookies } from "next/headers";

export const ACTIVE_PROJECT_COOKIE = "m9r_active_project";

/** Read the active workspace id from the cookie, or null when unset. */
export async function getActiveProjectId(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_PROJECT_COOKIE)?.value ?? null;
}

/** Cookie options shared by the switch route (1 year, app-wide, lax). */
export const ACTIVE_PROJECT_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
  httpOnly: false,
};
