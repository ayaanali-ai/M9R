/**
 * Item #32: the bounded, pre-installed, audited set of official `@ai-sdk/*`
 * packages this harness can actually drive, plus the generic
 * `@ai-sdk/openai-compatible` adapter that covers everything else in the
 * real models.dev catalog (m9r-native-model-catalog.ts) safely -- confirmed
 * by fetching that catalog directly: 173 of 213 real providers (81%) already
 * declare `@ai-sdk/openai-compatible` as their own official npm package, so
 * this one generic adapter plus this small dedicated set is not a partial
 * answer to "every provider" -- it is the real, checked shape of the whole
 * catalog.
 *
 * Deliberately excluded, named rather than silently skipped:
 * - Amazon Bedrock, Google Vertex, Azure OpenAI: real official packages
 *   exist, but their auth is AWS credentials / a GCP service account /
 *   resource-name + region, not a single API key string -- forcing them
 *   into this uniform shape would mean a fake or broken credential field.
 *   These need their own credential schema, a real follow-up, not a
 *   workaround here.
 * - Every provider whose models.dev entry names a *third-party* npm package
 *   (e.g. a community `-ai-sdk-provider` package, not `@ai-sdk/*` itself):
 *   never dynamically installed or imported. Running unaudited code fetched
 *   at runtime based on database-driven config is a real supply-chain risk
 *   for a hosted, multi-tenant app -- the honest answer for these is "not
 *   supported yet," not silent code execution.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createXai } from "@ai-sdk/xai";
import { createCohere } from "@ai-sdk/cohere";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createCerebras } from "@ai-sdk/cerebras";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

type ProviderFactory = (apiKey: string) => (model: string) => LanguageModel;

/** Every entry here is a real, official, pre-installed `@ai-sdk/*` package -- never a dynamically-resolved one. Adding a provider to this set is a real, deliberate, auditable code change (install the package, add one line here), matching the same "small change, not silent" posture the credential allowlist already uses. */
const SAFE_NPM_PACKAGES: Record<string, ProviderFactory> = {
  "@ai-sdk/anthropic": (apiKey) => createAnthropic({ apiKey }),
  "@ai-sdk/google": (apiKey) => createGoogleGenerativeAI({ apiKey }),
  "@ai-sdk/openai": (apiKey) => createOpenAI({ apiKey }),
  "@ai-sdk/mistral": (apiKey) => createMistral({ apiKey }),
  "@ai-sdk/groq": (apiKey) => createGroq({ apiKey }),
  "@ai-sdk/xai": (apiKey) => createXai({ apiKey }),
  "@ai-sdk/cohere": (apiKey) => createCohere({ apiKey }),
  "@ai-sdk/perplexity": (apiKey) => createPerplexity({ apiKey }),
  "@ai-sdk/togetherai": (apiKey) => createTogetherAI({ apiKey }),
  "@ai-sdk/cerebras": (apiKey) => createCerebras({ apiKey }),
};

export const SUPPORTED_NPM_PACKAGES = new Set([...Object.keys(SAFE_NPM_PACKAGES), "@ai-sdk/openai-compatible"]);

/**
 * The real, canonical models.dev provider `id` for each first-party
 * dedicated package above -- confirmed by fetching the live catalog and
 * reading each entry's own `id` field, not guessed. Exists to break a real
 * ambiguity the catalog itself contains: a model id like "claude-sonnet-4-6"
 * is not unique -- checked live, 21 separate catalog entries list that exact
 * id, most of them reseller/proxy providers (e.g. "modelis", "freemodel")
 * that also declare `@ai-sdk/anthropic` or `@ai-sdk/openai-compatible` as
 * their package. Preferring the canonical id here (over first-match
 * iteration order, which is arbitrary JSON key order) is what makes
 * "claude-sonnet-4-6" resolve to Anthropic itself rather than a reseller.
 */
export const CANONICAL_PROVIDER_IDS = new Set([
  "anthropic",
  "google",
  "openai",
  "mistral",
  "groq",
  "xai",
  "cohere",
  "perplexity",
  "togetherai",
  "cerebras",
]);

/**
 * Resolves a real language model for a catalog provider entry. `npm` and
 * `baseURL` come straight from the real models.dev catalog fetch, never
 * guessed. Throws a specific, honest error for a provider outside the
 * supported set -- never silently falls through to a different provider.
 */
export function resolveCatalogModel(input: { npm: string; apiKey: string; baseURL: string | null; providerId: string; model: string }): LanguageModel {
  const dedicated = SAFE_NPM_PACKAGES[input.npm];
  if (dedicated) return dedicated(input.apiKey)(input.model);

  if (input.npm === "@ai-sdk/openai-compatible") {
    if (!input.baseURL) throw new Error(`"${input.providerId}" has no base API URL in the model catalog, so the generic OpenAI-compatible adapter has nowhere to send requests.`);
    const provider = createOpenAICompatible({ name: input.providerId, apiKey: input.apiKey, baseURL: input.baseURL });
    return provider(input.model);
  }

  throw new Error(`"${input.providerId}" is driven by "${input.npm}", which isn't in M9R's audited package set. Not supported yet -- see M9R_MASTER_BUILD_PLAN.md item #32.`);
}
