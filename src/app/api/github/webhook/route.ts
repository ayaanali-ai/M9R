import { NextRequest, NextResponse } from "next/server";
import { verifyGithubWebhookSignature, renderGithubEventAsMessage, postGithubEventToBoundChannel, type GithubWebhookEventName } from "@/lib/github-events-service";

export const dynamic = "force-dynamic";

const HANDLED_EVENTS: ReadonlySet<string> = new Set<GithubWebhookEventName>(["push", "pull_request", "pull_request_review"]);

/**
 * POST /api/github/webhook — GitHub's own callback, never a user request.
 * Signature-verified against GITHUB_APP_WEBHOOK_SECRET (never trusts the body
 * without it), same discipline as billing/webhook.ts for Stripe. Always
 * returns 200 once verified so GitHub doesn't retry-storm an event this repo
 * simply isn't bound to a channel for — an unbound repo is a routing fact,
 * not a delivery failure.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const verification = verifyGithubWebhookSignature(rawBody, req.headers.get("x-hub-signature-256"));
  if (!verification.ok) {
    const status = verification.reason === "no_secret_configured" ? 503 : 401;
    return NextResponse.json({ error: verification.reason ?? "Invalid signature." }, { status });
  }

  const eventName = req.headers.get("x-github-event") ?? "";
  if (!HANDLED_EVENTS.has(eventName)) return NextResponse.json({ ok: true, handled: false });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const rendered = renderGithubEventAsMessage(eventName, payload);
  if (!rendered) return NextResponse.json({ ok: true, handled: false });

  try {
    const result = await postGithubEventToBoundChannel(rendered);
    return NextResponse.json({ ok: true, handled: true, posted: result.posted });
  } catch (error) {
    console.error("github/webhook failed to post event:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not record the event." }, { status: 500 });
  }
}
