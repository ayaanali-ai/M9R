import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import {
  isReviewerDemoClaims,
  reviewerDemoApiBlocked,
  reviewerDemoPageDestination,
} from "@/lib/reviewer-demo-access";

const PROTECTED_ROUTE_PREFIXES = ["/dashboard"] as const;

function isProtectedRoute(pathname: string) {
  return PROTECTED_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function createLoginRedirect(request: NextRequest) {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/auth";
  loginUrl.search = "";
  loginUrl.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(loginUrl);
}

function copyCookies(source: NextResponse, destination: NextResponse) {
  source.cookies.getAll().forEach((cookie) => destination.cookies.set(cookie));
  return destination;
}

export async function updateSession(
  request: NextRequest,
): Promise<NextResponse> {
  let response = NextResponse.next({
    request: { headers: request.headers },
  });
  const config = getSupabasePublicConfig();

  if (!config) {
    return isProtectedRoute(request.nextUrl.pathname)
      ? createLoginRedirect(request)
      : response;
  }

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  const isAuthenticated = !error && Boolean(data?.claims?.sub);

  if (isProtectedRoute(request.nextUrl.pathname) && !isAuthenticated) {
    return copyCookies(response, createLoginRedirect(request));
  }

  if (isAuthenticated && isReviewerDemoClaims(data?.claims)) {
    if (reviewerDemoApiBlocked(request.nextUrl.pathname)) {
      return copyCookies(
        response,
        NextResponse.json(
          { error: "Reviewer demo accounts cannot access this resource." },
          { status: 403 },
        ),
      );
    }
    const destination = reviewerDemoPageDestination(request.nextUrl.pathname);
    if (destination) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = destination;
      redirectUrl.search = "";
      return copyCookies(response, NextResponse.redirect(redirectUrl));
    }
  }

  return response;
}
