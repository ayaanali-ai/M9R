const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ContentLengthDecision = "ok" | "invalid" | "too_large";

export function evaluateContentLength(rawLength: string | null, maximum: number): ContentLengthDecision {
  if (rawLength === null) return "ok";
  const parsed = Number(rawLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return "invalid";
  return parsed > maximum ? "too_large" : "ok";
}

export function isCrossSiteWrite(input: {
  method: string;
  origin: string | null;
  fetchSite: string | null;
  allowedOrigins: ReadonlySet<string>;
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (input.origin) return !input.allowedOrigins.has(input.origin);
  return input.fetchSite === "cross-site";
}
