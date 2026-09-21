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
  hasBearerAuthorization: boolean;
  /** Whether the request carries ambient browser credentials. Defaults to true (fail closed) when a caller does not say. */
  hasCookies?: boolean;
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (input.origin) return !input.allowedOrigins.has(input.origin);
  if (input.fetchSite === "same-origin" || input.fetchSite === "same-site") return false;
  if (input.fetchSite === "cross-site") return true;
  // Neither Origin nor a recognized Sec-Fetch-Site was sent. Real browsers
  // always send Sec-Fetch-Site, so this only happens for non-browser
  // (server-to-server / CLI) callers -- and those are only safe to admit here
  // because a cross-site request forged via a victim's cookies can never
  // carry a bearer Authorization header the attacker doesn't have. Anything
  // else with both headers missing fails closed.
  // A CSRF attack rides the victim's ambient cookies, so a request with neither a
  // bearer token nor any cookie has nothing to forge (e.g. the CLI's unauthenticated
  // POST /api/agent/register, whose approval step still needs a logged-in human).
  return !input.hasBearerAuthorization && (input.hasCookies ?? true);
}
