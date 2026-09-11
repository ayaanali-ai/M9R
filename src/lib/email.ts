// Email sending via the Resend REST API — no SDK dependency, just fetch.
//
// Best-effort by design: returns false and NEVER throws when unconfigured or on
// error, so email failures can never break intake or referral crediting.
//
// Required env to actually send:
//   RESEND_API_KEY  — your Resend API key
//   RESEND_FROM     — verified sender, e.g. "OathLock <noreply@yourdomain.com>"
//                     (for testing you may use "OathLock <onboarding@resend.dev>",
//                      which can only send to your own Resend account email)

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type EmailMessage = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

export function emailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM;
}

export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) {
    console.info("[email] Resend not configured (RESEND_API_KEY/RESEND_FROM); skipping send.");
    return false;
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      // Log status only — never the message body.
      console.error(`[email] Resend send failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Resend error:", err instanceof Error ? err.message : "unknown");
    return false;
  }
}
