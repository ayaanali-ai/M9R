import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { guardApiRequest, secureApiResponse } from "@/lib/request-security";

function redirectHttpToHttps(request: NextRequest): Response | null {
  if (process.env.NODE_ENV !== "production") return null;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedProto !== "http") return null;
  const destination = request.nextUrl.clone();
  destination.protocol = "https:";
  return Response.redirect(destination, 308);
}

export async function proxy(request: NextRequest) {
  const httpsRedirect = redirectHttpToHttps(request);
  if (httpsRedirect) return httpsRedirect;
  const rejected = guardApiRequest(request);
  if (rejected) return secureApiResponse(request, rejected);
  return secureApiResponse(request, await updateSession(request));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
