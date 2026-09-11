const REVIEWER_DEMO_ROLE = "reviewer_demo";

const BLOCKED_PAGE_PREFIXES = [
  "/admin",
  "/compare",
  "/find-run-log",
  "/report",
  "/traces/upload",
] as const;

const BLOCKED_DASHBOARD_PREFIXES = [
  "/dashboard/projects",
  "/dashboard/rules",
  "/dashboard/settings",
  "/dashboard/traces",
  "/dashboard/memory",
] as const;

const BLOCKED_API_PREFIXES = [
  "/api/account",
  "/api/admin",
  "/api/agent",
  "/api/auth/debug",
  "/api/projects",
  "/api/rules",
  "/api/submit-trace",
  "/api/traces",
  "/api/walkthrough",
  "/api/workspace-rules",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function hasPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isReviewerDemoAppMetadata(metadata: unknown): boolean {
  const value = record(metadata);
  if (!value) return false;
  return value.role === REVIEWER_DEMO_ROLE || value.user_role === REVIEWER_DEMO_ROLE;
}

export function isReviewerDemoClaims(claims: unknown): boolean {
  return isReviewerDemoAppMetadata(record(claims)?.app_metadata);
}

export function reviewerDemoPageDestination(pathname: string): string | null {
  if (
    BLOCKED_DASHBOARD_PREFIXES.some((prefix) => hasPrefix(pathname, prefix)) ||
    BLOCKED_PAGE_PREFIXES.some((prefix) => hasPrefix(pathname, prefix))
  ) {
    return "/dashboard/agents";
  }
  return null;
}

export function reviewerDemoApiBlocked(pathname: string): boolean {
  return BLOCKED_API_PREFIXES.some((prefix) => hasPrefix(pathname, prefix));
}
