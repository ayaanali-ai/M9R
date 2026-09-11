export type ProviderUsageProvider = "openai" | "anthropic" | "xai";
export type ProviderUsageStatus = "available" | "not_configured" | "unsupported" | "error";

export type ProviderAccountUsage = {
  provider: ProviderUsageProvider;
  label: string;
  status: ProviderUsageStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
  periodStart: string;
  periodEnd: string;
  detail: string;
  /** Organization API usage is consumption telemetry, never consumer-plan allowance. */
  isConsumerAllowance: false;
};

export type ProviderUsageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type UsageEnvironment = Record<string, string | undefined>;

type LoaderOptions = {
  env?: UsageEnvironment;
  fetchImpl?: ProviderUsageFetch;
  now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 60_000;

let cached: { expiresAt: number; value: ProviderAccountUsage[] } | null = null;

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function base(
  provider: ProviderUsageProvider,
  label: string,
  status: ProviderUsageStatus,
  periodStart: string,
  periodEnd: string,
  detail: string,
): ProviderAccountUsage {
  return {
    provider,
    label,
    status,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    requests: null,
    periodStart,
    periodEnd,
    detail,
    isConsumerAllowance: false,
  };
}

function sumOpenAI(payload: unknown) {
  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  const buckets = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : [];
  for (const bucket of buckets) {
    const results = Array.isArray((bucket as { results?: unknown })?.results)
      ? (bucket as { results: unknown[] }).results
      : [];
    for (const result of results) {
      const row = result as Record<string, unknown>;
      inputTokens += finiteNumber(row.input_tokens);
      outputTokens += finiteNumber(row.output_tokens);
      requests += finiteNumber(row.num_model_requests);
    }
  }
  return { inputTokens, outputTokens, requests };
}

function sumAnthropic(payload: unknown) {
  let inputTokens = 0;
  let outputTokens = 0;
  const buckets = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : [];
  for (const bucket of buckets) {
    const results = Array.isArray((bucket as { results?: unknown })?.results)
      ? (bucket as { results: unknown[] }).results
      : [];
    for (const result of results) {
      const row = result as Record<string, unknown>;
      const cacheCreation = (row.cache_creation ?? {}) as Record<string, unknown>;
      inputTokens += finiteNumber(row.uncached_input_tokens);
      inputTokens += finiteNumber(row.cache_read_input_tokens);
      inputTokens += finiteNumber(cacheCreation.ephemeral_5m_input_tokens);
      inputTokens += finiteNumber(cacheCreation.ephemeral_1h_input_tokens);
      outputTokens += finiteNumber(row.output_tokens);
    }
  }
  return { inputTokens, outputTokens };
}

async function fetchJson(fetchImpl: ProviderUsageFetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Provider usage request failed (${response.status}).`);
  return response.json();
}

export async function loadProviderAccountUsage({
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
}: LoaderOptions = {}): Promise<ProviderAccountUsage[]> {
  const periodEnd = now.toISOString();
  const start = new Date(now.getTime() - 7 * DAY_MS);
  const periodStart = start.toISOString();

  const openAI = async (): Promise<ProviderAccountUsage> => {
    const key = env.OPENAI_ADMIN_API_KEY?.trim();
    if (!key) {
      return base("openai", "OpenAI API", "not_configured", periodStart, periodEnd, "Add an OpenAI Admin API key to read organization usage.");
    }
    try {
      const query = new URLSearchParams({
        start_time: String(Math.floor(start.getTime() / 1000)),
        end_time: String(Math.floor(now.getTime() / 1000)),
        bucket_width: "1d",
        limit: "7",
      });
      const payload = await fetchJson(fetchImpl, `https://api.openai.com/v1/organization/usage/completions?${query}`, {
        headers: { authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      const totals = sumOpenAI(payload);
      return {
        ...base("openai", "OpenAI API", "available", periodStart, periodEnd, "Organization API consumption for the last 7 days."),
        ...totals,
        totalTokens: totals.inputTokens + totals.outputTokens,
      };
    } catch {
      return base("openai", "OpenAI API", "error", periodStart, periodEnd, "Organization usage could not be loaded.");
    }
  };

  const anthropic = async (): Promise<ProviderAccountUsage> => {
    const key = env.ANTHROPIC_ADMIN_API_KEY?.trim();
    if (!key) {
      return base("anthropic", "Anthropic API", "not_configured", periodStart, periodEnd, "Add an Anthropic Admin API key to read organization usage.");
    }
    try {
      const query = new URLSearchParams({
        starting_at: periodStart,
        ending_at: periodEnd,
        bucket_width: "1d",
        limit: "7",
      });
      const payload = await fetchJson(fetchImpl, `https://api.anthropic.com/v1/organizations/usage_report/messages?${query}`, {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        cache: "no-store",
      });
      const totals = sumAnthropic(payload);
      return {
        ...base("anthropic", "Anthropic API", "available", periodStart, periodEnd, "Organization API consumption for the last 7 days; provider reporting may lag."),
        ...totals,
        totalTokens: totals.inputTokens + totals.outputTokens,
      };
    } catch {
      return base("anthropic", "Anthropic API", "error", periodStart, periodEnd, "Organization usage could not be loaded.");
    }
  };

  const xai = Promise.resolve(
    base("xai", "xAI API", "unsupported", periodStart, periodEnd, "xAI exposes per-response usage and cost, not an organization usage report supported here."),
  );

  return Promise.all([openAI(), anthropic(), xai]);
}

/** Best-effort process cache prevents fast dashboard refreshes from polling admin APIs. */
export async function loadCachedProviderAccountUsage(): Promise<ProviderAccountUsage[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await loadProviderAccountUsage();
  cached = { expiresAt: now + CACHE_MS, value };
  return value;
}
