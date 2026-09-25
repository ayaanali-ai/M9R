import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// The waitlist store and confirmation emails live in the m9r-launch Worker (D1 + Email Sending).
// A Worker cannot fetch another Worker of the same account over its public workers.dev URL, so production
// reaches it through a service binding; the public URL is only the fallback for local development.
const PUBLIC_ENDPOINT = "https://m9r-launch.m9r.workers.dev/api/waitlist";

type WaitlistService = { fetch: (request: Request) => Promise<Response> };

function waitlistService(): WaitlistService | null {
  try {
    const { env } = getCloudflareContext() as unknown as { env: { WAITLIST?: WaitlistService } };
    return env.WAITLIST ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 }); }
  const { email, agents } = (body ?? {}) as { email?: unknown; agents?: unknown };
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: typeof email === "string" ? email : "", agents: Array.isArray(agents) ? agents.slice(0, 8) : [] }),
  };
  try {
    const service = waitlistService();
    const upstream = service ? await service.fetch(new Request(PUBLIC_ENDPOINT, init)) : await fetch(PUBLIC_ENDPOINT, init);
    const data = await upstream.json().catch(() => ({ ok: false, error: "Something went wrong. Please try again." }));
    return NextResponse.json(data, { status: upstream.status, headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not reach the waitlist. Please try again." }, { status: 502 });
  }
}
