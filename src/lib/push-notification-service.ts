import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PushDecisionAction {
  url: string;
  method?: "POST";
  body: Record<string, unknown>;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  /**
   * Optional push-to-decision buttons: the service worker POSTs `decide[key]`
   * directly on click, hitting the exact same endpoint the dashboard button
   * for that decision already calls -- see public/sw.js. Safari/iOS ignores
   * `actions` and falls back to a plain notification; nothing breaks there.
   */
  actions?: Array<{ action: "approve" | "reject"; title: string }>;
  decide?: Partial<Record<"approve" | "reject", PushDecisionAction>>;
}

function configuredKeys(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export function webPushConfigured(): boolean {
  return configuredKeys() !== null;
}

/**
 * Best-effort background delivery. Durable in-app notifications are written
 * first; expired browser subscriptions are removed without exposing endpoint
 * values or provider errors to the request that created the notification.
 */
export async function sendPushNotificationForUser(
  client: SupabaseClient,
  userId: string,
  payload: PushNotificationPayload,
): Promise<{ sent: number; removed: number; failed: number }> {
  const keys = configuredKeys();
  if (!keys) return { sent: 0, removed: 0, failed: 0 };

  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const { data, error } = await client
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId)
    .limit(20);
  if (error) throw new Error(`Failed to load push subscriptions: ${error.message}`);

  let sent = 0;
  let removed = 0;
  let failed = 0;
  await Promise.all((data ?? []).map(async (row) => {
    const subscription = {
      endpoint: String(row.endpoint),
      keys: { p256dh: String(row.p256dh), auth: String(row.auth) },
    };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 300, urgency: "high" });
      sent += 1;
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        await client.from("push_subscriptions").delete().eq("id", String(row.id)).eq("user_id", userId);
        removed += 1;
      } else {
        failed += 1;
        console.warn("M9R push delivery failed", { statusCode: Number.isFinite(statusCode) ? statusCode : 0 });
      }
    }
  }));
  return { sent, removed, failed };
}
