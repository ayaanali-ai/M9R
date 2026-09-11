import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://m9r.vercel.app";

// The design-bench pages (src/app/design/*) are explicitly documented as
// static, no-auth reference/mockup surfaces not meant to represent the real
// product -- they shouldn't be indexed or discovered as if they were.
// /dashboard and /admin require auth and have nothing to index either way,
// but excluding them here keeps crawlers from wasting time on 401s.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/design/", "/dashboard/", "/admin/", "/api/"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
