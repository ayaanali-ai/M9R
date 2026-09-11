// Provider integration safety helpers — conservative, dependency-free guards for
// the future real-provider live test. No external calls, no provider SDK.
//
// These are best-effort string checks, NOT a security guarantee. Always review a
// trace before sharing. See docs/REAL_PROVIDER_TRACE_PRIVACY.md and
// docs/REAL_PROVIDER_LIVE_TEST_POLICY.md.

// Obvious key/secret shapes. Conservative on purpose — favors catching common
// real shapes (OpenAI/Anthropic-style keys, bearer tokens) over cleverness.
const API_KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic-style
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /AIza[A-Za-z0-9_-]{10,}/g, // Google-style
];
const BEARER_PATTERN = /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Live provider tests run ONLY when explicitly enabled. Default off.
export function isLiveProviderTestEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.RUNLEAK_PROVIDER_TEST_ENABLED === "true";
}

// Throw if text looks like it contains an API key. Use before writing trace text
// derived from a real run.
export function assertNoApiKeyInTraceText(text: string): void {
  for (const re of API_KEY_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      throw new Error(
        "Refusing to record: text appears to contain an API key. Redact before saving.",
      );
    }
  }
}

// Best-effort redaction of obvious secrets/PII. Not a guarantee.
export function redactProviderSecrets(text: string): string {
  let out = text;
  for (const re of API_KEY_PATTERNS) {
    out = out.replace(re, "[REDACTED_API_KEY]");
  }
  out = out.replace(BEARER_PATTERN, "$1[REDACTED]");
  out = out.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  return out;
}
