/**
 * Model cost model — OathLock Phase 1
 * ----------------------------------------------------------------------------
 * A small, transparent price table used to *estimate* cost when a trace does
 * not carry an explicit cost (many providers report tokens but not dollars).
 *
 * Honesty rules:
 *  - Estimates are clearly labelled as estimates by callers (see trace-metrics).
 *  - We only estimate when we have BOTH a recognized model and token counts.
 *  - Prices are approximate public list prices (USD per 1M tokens) and are easy
 *    to update. A trace that embeds its own `pricing` rates always wins over
 *    this table (handled in usage-normalization.extractCost).
 *
 * The `tier` field doubles as an MTM capability rank (1 = light, 2 = mid,
 * 3 = frontier) so model-to-model handoff analysis can reason about
 * escalations (weak → strong) and distillation patterns (strong → weak).
 */

export type ModelTier = 1 | 2 | 3;

export interface ModelPrice {
  /** Canonical label for display. */
  label: string;
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPerMTok: number;
  /** Capability/cost tier — also used as the MTM escalation rank. */
  tier: ModelTier;
}

/**
 * Price table keyed by a lowercase *substring* that identifies the model
 * family. Matching is fuzzy (see {@link lookupModelPrice}) so versioned ids
 * like "claude-sonnet-4-6-20260101" or "gpt-4o-2024-08-06" still resolve.
 *
 * Ordered most-specific first so e.g. "gpt-4o-mini" wins over "gpt-4o".
 */
const PRICE_TABLE: Array<{ match: string; price: ModelPrice }> = [
  // --- Anthropic ----------------------------------------------------------
  { match: "haiku", price: { label: "Claude Haiku", inputPerMTok: 0.8, outputPerMTok: 4, tier: 1 } },
  { match: "opus", price: { label: "Claude Opus", inputPerMTok: 15, outputPerMTok: 75, tier: 3 } },
  { match: "sonnet", price: { label: "Claude Sonnet", inputPerMTok: 3, outputPerMTok: 15, tier: 2 } },
  // --- OpenAI -------------------------------------------------------------
  { match: "gpt-4o-mini", price: { label: "GPT-4o mini", inputPerMTok: 0.15, outputPerMTok: 0.6, tier: 1 } },
  { match: "gpt-4o", price: { label: "GPT-4o", inputPerMTok: 2.5, outputPerMTok: 10, tier: 2 } },
  { match: "gpt-4-turbo", price: { label: "GPT-4 Turbo", inputPerMTok: 10, outputPerMTok: 30, tier: 3 } },
  { match: "gpt-4", price: { label: "GPT-4", inputPerMTok: 30, outputPerMTok: 60, tier: 3 } },
  { match: "gpt-3.5", price: { label: "GPT-3.5", inputPerMTok: 0.5, outputPerMTok: 1.5, tier: 1 } },
  { match: "o3", price: { label: "OpenAI o3", inputPerMTok: 10, outputPerMTok: 40, tier: 3 } },
  { match: "o1", price: { label: "OpenAI o1", inputPerMTok: 15, outputPerMTok: 60, tier: 3 } },
  // --- Google Gemini ------------------------------------------------------
  { match: "gemini-1.5-flash", price: { label: "Gemini 1.5 Flash", inputPerMTok: 0.075, outputPerMTok: 0.3, tier: 1 } },
  { match: "gemini-2.0-flash", price: { label: "Gemini 2.0 Flash", inputPerMTok: 0.1, outputPerMTok: 0.4, tier: 1 } },
  { match: "flash", price: { label: "Gemini Flash", inputPerMTok: 0.1, outputPerMTok: 0.4, tier: 1 } },
  { match: "gemini", price: { label: "Gemini Pro", inputPerMTok: 1.25, outputPerMTok: 5, tier: 2 } },
];

/**
 * Resolve a model identifier to a price entry via fuzzy substring match.
 * Returns null for unknown models — callers must treat that as "not estimable"
 * rather than guessing.
 */
export function lookupModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const key = model.trim().toLowerCase();
  if (!key) return null;
  for (const { match, price } of PRICE_TABLE) {
    if (key.includes(match)) return price;
  }
  return null;
}

/** MTM capability rank for a model, or null when the model is unknown. */
export function getModelTier(model: string | null | undefined): ModelTier | null {
  return lookupModelPrice(model)?.tier ?? null;
}

/**
 * Estimate the USD cost of a single model call from token counts.
 *
 * Returns null (not 0) when the model is unknown or token data is insufficient,
 * so the caller can stay honest about what is measured vs. estimated. When only
 * a `total` is known (no input/output split), we approximate using a blended
 * rate — flagged by the caller as a coarser estimate.
 */
export function estimateCostFromTokens(
  model: string | null | undefined,
  input: number | null,
  output: number | null,
  total: number | null,
): number | null {
  const price = lookupModelPrice(model);
  if (!price) return null;

  if (input != null && output != null) {
    return (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000;
  }
  // Fallback: blend input/output rates against a known total. Coarser, but far
  // better than reporting "unknown" when a total is clearly present.
  if (total != null) {
    const blended = (price.inputPerMTok + price.outputPerMTok) / 2;
    return (total * blended) / 1_000_000;
  }
  return null;
}

/** Human label for a tier — used in MTM signal descriptions. */
export function tierLabel(tier: ModelTier): string {
  return tier === 3 ? "frontier" : tier === 2 ? "mid" : "light";
}
