/**
 * Safe post-login redirect resolution (OathLock)
 * ----------------------------------------------------------------------------
 * A signed-out human who opens a claim URL (or any protected page) is sent to
 * /auth with a `next` param so they return to where they started. `next` is
 * attacker-controllable, so it must be validated before we ever redirect to it:
 *
 *  - only allow relative, same-origin paths starting with a single "/",
 *  - reject absolute/external URLs (http://evil.com),
 *  - reject protocol-relative URLs (//evil.com) and backslash variants (/\evil),
 *  - fall back to /dashboard for anything unsafe or missing.
 *
 * Pure + dependency-free so it is shared by the auth page, the auth callback,
 * and the sign-in form, and trivially unit-testable.
 */

export const DEFAULT_POST_LOGIN = "/dashboard";

// Control chars + whitespace, built via RegExp so no literal control characters
// live in this source file. Used to reject values that could slip past the
// structural checks once a browser normalizes them.
const UNSAFE_CHARS_RE = new RegExp("[\\u0000-\\u0020\\u007F]");

/**
 * Resolve a safe relative redirect target. Returns `fallback` for anything that
 * is missing, not a relative path, or an open-redirect attempt.
 */
export function safeRelativePath(
  value: string | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN,
): string {
  if (typeof value !== "string" || value.length === 0) return fallback;

  // Must be a relative path beginning with exactly one slash.
  if (!value.startsWith("/")) return fallback;

  // Reject protocol-relative ("//host") and backslash-smuggled ("/\\host")
  // forms — browsers treat both as absolute, which would be an open redirect.
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;

  // Reject control characters / whitespace.
  if (UNSAFE_CHARS_RE.test(value)) return fallback;

  return value;
}

/**
 * Build a sign-in link that returns the human to where they started after auth.
 * `returnTo` is sanitized first, so an unsafe value falls back to /dashboard and
 * can never produce an open redirect.
 */
export function buildSignInHref(returnTo: string | null | undefined): string {
  const safe = safeRelativePath(returnTo);
  return `/auth?next=${encodeURIComponent(safe)}`;
}
