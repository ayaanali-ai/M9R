// Instant lead notifications via an incoming webhook (Discord or Slack).
//
// One env var, LEAD_WEBHOOK_URL, works for either platform: we send both
// `content` (Discord's field) and `text` (Slack's field) in the payload, and
// each service reads the key it understands and ignores the other.
//
// Best-effort by design: returns false and NEVER throws, so a webhook failure
// can never break intake or referral crediting.
//
// To get a URL:
//   Discord — Server Settings → Integrations → Webhooks → New Webhook → Copy URL
//   Slack   — api.slack.com/apps → Incoming Webhooks → Add to workspace → Copy URL

export function leadWebhookEnabled(): boolean {
  return !!process.env.LEAD_WEBHOOK_URL;
}

// Core sender. Posts both `content` (Discord) and `text` (Slack); each service
// reads the key it understands. Best-effort: returns false, never throws.
async function postWebhook(url: string, text: string, label: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Discord truncates content at 2000 chars; keep messages short.
      body: JSON.stringify({ content: text, text }),
    });
    if (!res.ok) {
      console.error(`[notify] ${label} webhook failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] ${label} webhook error:`, err instanceof Error ? err.message : "unknown");
    return false;
  }
}

export async function notifyLead(text: string): Promise<boolean> {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) {
    console.info("[notify] LEAD_WEBHOOK_URL not set; skipping webhook.");
    return false;
  }
  return postWebhook(url, text, "lead");
}

// Signup ping. Uses a dedicated SIGNUP_WEBHOOK_URL if set, otherwise falls back
// to the shared LEAD_WEBHOOK_URL so a single channel can cover both.
export async function notifySignup(text: string): Promise<boolean> {
  const url = process.env.SIGNUP_WEBHOOK_URL || process.env.LEAD_WEBHOOK_URL;
  if (!url) {
    console.info("[notify] no signup webhook URL set; skipping webhook.");
    return false;
  }
  return postWebhook(url, text, "signup");
}
