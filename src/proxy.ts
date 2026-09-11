import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { guardApiRequest, secureApiResponse } from "@/lib/request-security";

export async function proxy(request: NextRequest) {
  const rejected = guardApiRequest(request);
  if (rejected) return secureApiResponse(request, rejected);
  return secureApiResponse(request, await updateSession(request));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
