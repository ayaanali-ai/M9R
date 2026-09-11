const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_KEY_LENGTH = 512;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

/** Parse only the browser PushSubscription fields OathLock persists. */
export function parsePushSubscription(value: unknown): PushSubscriptionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const endpoint = boundedString(record.endpoint, MAX_ENDPOINT_LENGTH);
  const keys = record.keys && typeof record.keys === "object" && !Array.isArray(record.keys)
    ? record.keys as Record<string, unknown>
    : null;
  const p256dh = boundedString(keys?.p256dh, MAX_KEY_LENGTH);
  const auth = boundedString(keys?.auth, MAX_KEY_LENGTH);
  if (!endpoint || !p256dh || !auth || !BASE64_URL.test(p256dh) || !BASE64_URL.test(auth)) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

/** Convert a VAPID public key into the bytes required by PushManager. */
export function base64UrlToUint8Array(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = window.atob(`${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}
