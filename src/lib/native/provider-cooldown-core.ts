/**
 * Shared provider usage-limit cooldown parsing. Native pill sessions and the
 * workspace bridge must interpret the provider's reset message the same way.
 */
export const PROVIDER_USAGE_LIMIT_FALLBACK_COOLDOWN_MS = 30 * 60_000;

/**
 * Return the provider-stated reset time when available, otherwise a bounded
 * fallback for an explicit quota/rate-limit failure. Unrelated failures return
 * null so ordinary crashes and transient errors remain diagnosable/retryable.
 */
export function detectProviderUsageLimitCooldownUntil(reason: string, nowMs = Date.now()): number | null {
  if (!/usage limit|quota|rate limit/i.test(reason)) return null;
  const match = reason.match(/try again at ([^.()]+)/i);
  if (match) {
    // Provider messages use ordinal days (e.g. Sep 14th), which Date.parse
    // rejects without normalization.
    const withoutOrdinals = match[1].trim().replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
    const parsed = Date.parse(withoutOrdinals);
    if (Number.isFinite(parsed) && parsed > nowMs) return parsed;
  }
  return nowMs + PROVIDER_USAGE_LIMIT_FALLBACK_COOLDOWN_MS;
}
