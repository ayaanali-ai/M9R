/**
 * Provider-neutral failure classification at the managed-provider boundary.
 * This preserves the actual failure family for the pill and task receipt
 * instead of collapsing quota, configuration, and transport failures into a
 * generic "internal service" state.
 */

export type ProviderFailureKind =
  | "usage-limit"
  | "authentication"
  | "model-not-found"
  | "timeout"
  | "not-running"
  | "internal"
  | "unknown";

export interface ProviderFailureClassification {
  readonly kind: ProviderFailureKind;
  readonly message: string;
  readonly retryable: boolean;
}

function compact(value: string): string {
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return text ? text.slice(0, 1_200) : "no provider diagnostic was returned";
}

/** Classify raw provider/transport text without making a retry decision from UI state. */
export function classifyProviderFailure(provider: string, value: string): ProviderFailureClassification {
  const raw = compact(value);
  const kind: ProviderFailureKind = /usage limit|free usage|quota|rate limit|too many requests/i.test(raw)
    ? "usage-limit"
    : /model (?:not found|unavailable)|unknown model|invalid model|does not support model/i.test(raw)
      ? "model-not-found"
      : /authentication|unauthori[sz]ed|not authenticated|invalid (?:api )?key|login required|\b401\b/i.test(raw)
        ? "authentication"
        : /timeout|timed out|no response within|deadline exceeded/i.test(raw)
          ? "timeout"
          : /server exited|process exited|connection refused|connection reset|not running|closed/i.test(raw)
            ? "not-running"
            : /internal service|internal server|apierror|acp error|transport/i.test(raw)
              ? "internal"
              : "unknown";
  const retryable = kind === "timeout" || kind === "not-running" || kind === "internal" || kind === "unknown";
  return { kind, retryable, message: `${provider} ${kind}: ${raw}` };
}
