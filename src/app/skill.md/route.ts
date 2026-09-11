import { NextRequest } from "next/server";
import { buildSkillMarkdown } from "@/lib/agent-md";

// ---------------------------------------------------------------------------
// GET /skill.md — mirrors /agent.md so skill.md-style onboarding (recognized by
// some agent ecosystems) resolves to the same OathLock contract. The body
// points at /agent.md as the canonical source and inlines the same instructions.
// ---------------------------------------------------------------------------

function baseUrl(req: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return "https://m9r.vercel.app";
}

export async function GET(req: NextRequest) {
  return new Response(buildSkillMarkdown(baseUrl(req)), {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
