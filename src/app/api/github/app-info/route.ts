import { NextResponse } from "next/server";
import { getGithubAppSlug } from "@/lib/github-app-api";

export const dynamic = "force-dynamic";

/** GET /api/github/app-info — the App's own public slug, used client-side to build the "Connect GitHub" install link. Public app metadata (GitHub itself serves it with no auth on github.com/apps/{slug}); no workspace scoping needed. */
export async function GET() {
  try {
    const slug = await getGithubAppSlug();
    return NextResponse.json({ slug });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve the GitHub App." }, { status: 503 });
  }
}
