/**
 * Provider-agnostic usage extraction.
 *
 * Values are accepted only when explicitly present. Numeric strings are
 * tolerated because JSON exporters commonly serialize numbers that way.
 * Missing input/output values remain null; zero is never substituted.
 */

export type NormalizedTokenUsage = {
  input: number | null;
  output: number | null;
  total: number | null;
};

export type DataCompleteness = "none" | "partial" | "complete";

type Obj = Record<string, unknown>;

function object(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function valueAt(root: unknown, paths: string[]): unknown {
  for (const path of paths) {
    let current: unknown = root;
    const segments = path.split(".");
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const record = object(current);
      if (!record) {
        current = undefined;
        break;
      }
      const remaining = segments.slice(index).join(".");
      // OTEL exporters commonly use literal dotted attribute keys.
      if (remaining in record) {
        current = record[remaining];
        break;
      }
      if (!(segment in record)) {
        current = undefined;
        break;
      }
      current = record[segment];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

const USAGE_CONTAINERS = [
  "",
  "usage",
  "token_usage",
  "tokenUsage",
  "usageMetadata",
  "usage_metadata",
  "attributes",
] as const;

function candidatePaths(names: string[]): string[] {
  return USAGE_CONTAINERS.flatMap((prefix) =>
    names.map((name) => prefix ? `${prefix}.${name}` : name),
  );
}

export function extractTokenUsage(raw: unknown): {
  usage: NormalizedTokenUsage | null;
  completeness: DataCompleteness;
  totalDerived: boolean;
} {
  const input = finiteNumber(valueAt(raw, candidatePaths([
    "input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens",
    "promptTokenCount", "gen_ai.usage.input_tokens",
  ])));
  const output = finiteNumber(valueAt(raw, candidatePaths([
    "output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens",
    "candidatesTokenCount", "candidateTokenCount", "gen_ai.usage.output_tokens",
  ])));
  const explicitTotal = finiteNumber(valueAt(raw, candidatePaths([
    "total", "total_tokens", "totalTokens", "totalTokenCount",
    "gen_ai.usage.total_tokens",
  ])));

  if (input === null && output === null && explicitTotal === null) {
    return { usage: null, completeness: "none", totalDerived: false };
  }

  const totalDerived = explicitTotal === null && input !== null && output !== null;
  const total = explicitTotal ?? (totalDerived ? input! + output! : null);
  const completeness = input !== null && output !== null && total !== null ? "complete" : "partial";
  return { usage: { input, output, total }, completeness, totalDerived };
}

export function extractCost(raw: unknown): {
  costUsd: number | null;
  source: "explicit" | "embedded-rates" | "none";
} {
  const explicit = finiteNumber(valueAt(raw, [
    "estimated_cost_usd", "estimatedCostUsd", "cost_usd", "costUsd",
    "total_cost_usd", "totalCostUsd",
    "cost.total_usd", "cost.totalUsd", "usage.cost_usd", "usage.costUsd",
  ]));
  if (explicit !== null) return { costUsd: explicit, source: "explicit" };

  const usage = extractTokenUsage(raw).usage;
  const inputRate = finiteNumber(valueAt(raw, [
    "pricing.input_usd_per_million_tokens", "pricing.inputUsdPerMillionTokens",
    "rates.input_usd_per_million_tokens", "rates.inputUsdPerMillionTokens",
  ]));
  const outputRate = finiteNumber(valueAt(raw, [
    "pricing.output_usd_per_million_tokens", "pricing.outputUsdPerMillionTokens",
    "rates.output_usd_per_million_tokens", "rates.outputUsdPerMillionTokens",
  ]));
  if (usage?.input !== null && usage?.input !== undefined &&
      usage?.output !== null && usage?.output !== undefined &&
      inputRate !== null && outputRate !== null) {
    return {
      costUsd: (usage.input * inputRate + usage.output * outputRate) / 1_000_000,
      source: "embedded-rates",
    };
  }
  return { costUsd: null, source: "none" };
}

export function summarizeUsage(raw: { steps?: unknown[]; totals?: unknown }) {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  let input = 0;
  let output = 0;
  let total = 0;
  let inputKnown = false;
  let outputKnown = false;
  let totalKnown = false;
  let cost = 0;
  let costKnown = false;
  let stepsWithUsage = 0;
  let completeUsageSteps = 0;
  let stepsWithCost = 0;

  for (const step of steps) {
    const extracted = extractTokenUsage(step);
    if (extracted.usage) {
      stepsWithUsage += 1;
      if (extracted.completeness === "complete") completeUsageSteps += 1;
      if (extracted.usage.input !== null) { input += extracted.usage.input; inputKnown = true; }
      if (extracted.usage.output !== null) { output += extracted.usage.output; outputKnown = true; }
      if (extracted.usage.total !== null) { total += extracted.usage.total; totalKnown = true; }
    }
    const extractedCost = extractCost(step);
    if (extractedCost.costUsd !== null) {
      cost += extractedCost.costUsd;
      costKnown = true;
      stepsWithCost += 1;
    }
  }

  const aggregateUsage = extractTokenUsage(raw.totals).usage;
  const aggregateCost = extractCost(raw.totals).costUsd;
  const tokens = {
    input: aggregateUsage?.input ?? (inputKnown ? input : null),
    output: aggregateUsage?.output ?? (outputKnown ? output : null),
    total: aggregateUsage?.total ?? (totalKnown ? total : null),
  };
  const tokenCoverage = steps.length ? stepsWithUsage / steps.length : 0;
  const tokenCompleteness: DataCompleteness =
    stepsWithUsage === 0 && !aggregateUsage
      ? "none"
      : tokenCoverage === 1 && completeUsageSteps === steps.length
        ? "complete"
        : "partial";

  return {
    tokens,
    costUsd: aggregateCost ?? (costKnown ? cost : null),
    tokenCoverage,
    costCoverage: steps.length ? stepsWithCost / steps.length : 0,
    tokenCompleteness,
  };
}
