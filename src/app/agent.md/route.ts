import { NextRequest } from "next/server";
import { buildAgentMarkdown } from "@/lib/agent-md";

// ---------------------------------------------------------------------------
// GET /agent.md — machine-readable onboarding for AI coding agents.
//
// Served as text/markdown (not HTML) so an agent that fetches the URL reads the
// instruction contract directly. Content lives in lib/agent-md.ts so it can be
// unit-tested and reused by /skill.md.
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
  return new Response(buildAgentMarkdown(baseUrl(req)), {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
