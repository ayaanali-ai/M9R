import type { MetadataRoute } from "next";

// Hosting has moved before (Vercel -> Render) without this ever being
// touched, silently pointing crawlers at a dead host -- reading the env
// var first means the next move doesn't require another manual edit here.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://m9r.vercel.app";

// Only real, public, non-redirecting marketing/legal pages. Excludes:
// /leaks (a redirect, not a page), /design/* (no-auth reference mockups,
// see robots.ts), /dashboard and /admin (auth-gated), /claim and /auth
// (single-use flows, not destinations), /report/session and /resume/[slug]
// (dynamic pages with no fixed set of valid params to enumerate here).
export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/pricing", "/security", "/roadmap", "/hackathon", "/terms", "/privacy", "/acceptable-use", "/data-processing"];
  return staticRoutes.map((route) => ({
    url: `${siteUrl}${route}`,
    lastModified: new Date(),
  }));
}
