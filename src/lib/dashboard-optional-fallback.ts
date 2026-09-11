/** Optional dashboard tables must degrade to an explicit unavailable state
 * while a deployment is between application code and its approved migration.
 * This classifier is intentionally narrow so real database failures remain
 * visible instead of being mislabeled as an empty dashboard. */
export function isMissingOptionalTableError(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const message = error instanceof Error ? error.message : typeof record?.message === "string" ? record.message : String(error ?? "");
  return code === "42P01" || code === "PGRST205" || /does not exist|relation .* not found|could not find (?:the )?table|schema cache|table .* not found/i.test(message);
}
