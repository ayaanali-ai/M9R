const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ContentLengthDecision = "ok" | "invalid" | "too_large";

/** Inspect bytes on a clone so signature verification and route parsing retain the original body. */
export async function evaluateBodySize(request: Request, maximum: number, timeoutMs = 30_000): Promise<ContentLengthDecision | "timed_out"> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid request body limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid request body deadline");
  const reader = request.clone().body?.getReader();
  if (!reader) return "ok";
  let size = 0;
  let accepted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), timeoutMs); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === "timed_out") return chunk;
      if (chunk.done) { accepted = true; return "ok"; }
      size += chunk.value.byteLength;
      if (size > maximum) return "too_large";
    }
  } finally {
    clearTimeout(timer);
    // Stop both tee branches on rejection; otherwise the unread original can retain the upload.
    if (!accepted) void request.body?.cancel().catch(() => {});
    // A tee's cancel promise can wait for the route's original branch; never await it here.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Request handlers parse whole bodies; attachments alone have an existing 25 MiB allowance. */
export function apiBodyLimit(pathname: string, configuredDefault: number): number {
  if (/^\/api\/dashboard\/conversations\/[^/]+\/attachments\/?$/.test(pathname)) return 26 * 1024 * 1024;
  return Math.min(configuredDefault, 32 * 1024 * 1024);
}

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
