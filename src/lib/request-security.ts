import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { evaluateContentLength, isCrossSiteWrite } from "@/lib/request-security-core";

const DEFAULT_MAX_API_BODY_BYTES = 4 * 1024 * 1024;

/** Constant-time comparison for high-privilege static bearer credentials. */
export function authorizedStaticBearer(request: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const supplied = request.headers.get("authorization") ?? "";
  const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function configuredOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>([request.nextUrl.origin]);
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      origins.add(new URL(configured).origin);
    } catch {
      // A malformed deployment variable must not broaden the origin allowlist.
    }
  }
  const vercelHost = process.env.VERCEL_URL?.trim();
  if (vercelHost) origins.add(`https://${vercelHost}`);
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }
  return origins;
}

function configuredBodyLimit(): number {
  const value = Number(process.env.MAX_API_BODY_BYTES);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_API_BODY_BYTES;
}

/** Reject malformed, oversized, or cross-site state-changing API requests. */
export function guardApiRequest(request: NextRequest): NextResponse | null {
  if (!request.nextUrl.pathname.startsWith("/api/")) return null;

  const rawLength = request.headers.get("content-length");
  const lengthDecision = evaluateContentLength(rawLength, configuredBodyLimit());
  if (lengthDecision === "invalid") {
    return NextResponse.json({ error: "Invalid Content-Length." }, { status: 400 });
  }
  if (lengthDecision === "too_large") {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }

  if (isCrossSiteWrite({
    method: request.method,
    origin: request.headers.get("origin"),
    fetchSite: request.headers.get("sec-fetch-site"),
    allowedOrigins: configuredOrigins(request),
  })) {
    return NextResponse.json({ error: "Cross-site request rejected." }, { status: 403 });
  }

  return null;
}

/** Prevent private API data from entering browser, proxy, or CDN caches. */
export function secureApiResponse(request: NextRequest, response: NextResponse): NextResponse {
  if (!request.nextUrl.pathname.startsWith("/api/")) return response;
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
