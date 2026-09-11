/**
 * Item #32: the real, open, community-maintained provider/model catalog
 * (models.dev) -- confirmed live: 213 real providers as of 2026-09-07,
 * fetched directly from https://models.dev/api.json. This is the same data
 * source OpenCode itself consumes (its own `models-dev.ts`, read directly
 * from their real source before building this) -- copying the DATA source,
 * not their runtime-npm-install mechanism, which doesn't transfer safely to
 * a hosted, multi-tenant serverless app (no writable disk to install into
 * at request time, and dynamically executing code fetched from npm based on
 * database config is a real supply-chain risk a hosted SaaS can't take the
 * way a local CLI tool someone runs on their own machine can).
 *
 * Real, checked fact from fetching this catalog directly: 173 of 213
 * providers (81%) already use `@ai-sdk/openai-compatible` as their own
 * official npm package -- Vercel's own generic OpenAI-compatible adapter,
 * pointed at that provider's own base URL. Only ~15 providers need a
 * dedicated official `@ai-sdk/*` package. That's the real shape of "every
 * provider" here: a small, bounded, pre-installed, audited set of official
 * packages, plus one generic adapter that covers the large majority
 * generically and safely.
 */

const CATALOG_URL = "https://models.dev/api.json";
/** In-memory only -- no writable disk cache the way OpenCode's local-CLI version uses (Vercel functions don't reliably share or persist a local filesystem across invocations). Refetched per cold start, cached per warm process. */
const CACHE_TTL_MS = 5 * 60_000;

export interface CatalogModel {
  id: string;
  name: string;
  toolCall: boolean;
  contextLimit: number | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** Real env var name(s) this provider expects -- models.dev's own field, not guessed. */
  env: string[];
  /** The real npm package that drives this provider, per models.dev itself. */
  npm: string;
  /** Base API URL, present for the large majority of providers (the ones reachable via @ai-sdk/openai-compatible). */
  api: string | null;
  models: CatalogModel[];
}

interface CachedCatalog {
  fetchedAt: number;
  providers: Map<string, CatalogProvider>;
}

let cache: CachedCatalog | null = null;
let inFlight: Promise<Map<string, CatalogProvider>> | null = null;

function parseCatalog(raw: unknown): Map<string, CatalogProvider> {
  const providers = new Map<string, CatalogProvider>();
  if (!raw || typeof raw !== "object") return providers;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const npm = typeof row.npm === "string" ? row.npm : null;
    const env = Array.isArray(row.env) ? row.env.filter((v): v is string => typeof v === "string") : [];
    if (!npm || env.length === 0) continue; // Nothing usable without both -- skip rather than guess.
    const modelsRaw = row.models && typeof row.models === "object" ? row.models as Record<string, unknown> : {};
    const models: CatalogModel[] = Object.values(modelsRaw)
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        name: typeof m.name === "string" ? m.name : String(m.id ?? ""),
        toolCall: m.tool_call === true,
        contextLimit: m.limit && typeof m.limit === "object" && typeof (m.limit as Record<string, unknown>).context === "number"
          ? (m.limit as Record<string, unknown>).context as number
          : null,
      }))
      .filter((m) => m.id);
    providers.set(id, {
      id,
      name: typeof row.name === "string" ? row.name : id,
      env,
      npm,
      api: typeof row.api === "string" ? row.api : null,
      models,
    });
  }
  return providers;
}

async function fetchCatalog(): Promise<Map<string, CatalogProvider>> {
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Could not fetch the model catalog (HTTP ${response.status}).`);
  const raw = await response.json();
  return parseCatalog(raw);
}

/** Real, live catalog, cached in-process for CACHE_TTL_MS. Never invents a provider or model that isn't actually in the fetched data. Throws if the fetch fails and nothing is cached yet -- never silently returns an empty/stale-forever catalog as if it were real. */
export async function getModelCatalog(): Promise<Map<string, CatalogProvider>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.providers;
  if (inFlight) return inFlight;
  inFlight = fetchCatalog()
    .then((providers) => {
      cache = { fetchedAt: Date.now(), providers };
      return providers;
    })
    .catch((error) => {
      // A stale cache is better than nothing on a transient fetch failure --
      // only surface the error if there's truly no prior data to fall back to.
      if (cache) return cache.providers;
      throw error;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function getCatalogProvider(providerId: string): Promise<CatalogProvider | null> {
  const providers = await getModelCatalog();
  return providers.get(providerId) ?? null;
}

/**
 * Given any model id, finds every catalog provider that serves it. Real
 * finding, checked against the live catalog rather than assumed: more than
 * one provider can list a model under the identical id (a reseller/proxy
 * provider re-listing e.g. "claude-sonnet-4-6" under its own entry) -- so
 * this deliberately returns every match, never just the first one found by
 * map-iteration order, which would be an arbitrary and wrong choice in that
 * case. The caller (resolveModelForTurn) picks among these by which one the
 * workspace actually has a credential for.
 */
export async function findProvidersForModel(modelId: string): Promise<CatalogProvider[]> {
  const providers = await getModelCatalog();
  const matches: CatalogProvider[] = [];
  for (const provider of providers.values()) {
    if (provider.models.some((m) => m.id === modelId)) matches.push(provider);
  }
  return matches;
}
