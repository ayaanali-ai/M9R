// Mass & Energy Ledger — resource accounting for AI-agent traces.
//
// CLAIM DISCIPLINE: Every energy / heat / infrastructure-burden value produced
// here is a MODELED ESTIMATE derived from trace-level token math and a
// configurable joules-per-1k-tokens assumption. None of these are hardware
// measurements. See docs/claims.md and REQUIRED_LEDGER_CAVEAT below.

export type DeploymentMode =
  | "earth_datacenter"
  | "edge_robotics"
  | "orbital_compute"
  | "mars_habitat";

export const REQUIRED_LEDGER_CAVEAT =
  "Energy, heat, and infrastructure-burden values are estimates based on " +
  "configurable assumptions. RunLeak currently measures trace-derived waste " +
  "such as repeated context, token duplication, and execution patterns. " +
  "Hardware-level validation requires direct telemetry.";

export const DEPLOYMENT_LABELS: Record<DeploymentMode, string> = {
  earth_datacenter: "Earth Data Center",
  edge_robotics: "Edge / Robotics",
  orbital_compute: "Orbital Compute",
  mars_habitat: "Mars Habitat",
};

// Directional multipliers used only for the relative burden index. These are
// not physical constants; they express how much more an avoidable-waste
// fraction "matters" under more resource-constrained deployment assumptions.
export const DEPLOYMENT_BURDEN_MULTIPLIER: Record<DeploymentMode, number> = {
  earth_datacenter: 1.0,
  edge_robotics: 1.2,
  orbital_compute: 1.8,
  mars_habitat: 1.5,
};

export type ResourceLedger = {
  totalTokens: number;
  wastedTokens: number;
  wasteFraction: number;

  totalCostUsd?: number;
  wastedCostUsd?: number;

  totalLatencyMs?: number;
  wastedLatencyMs?: number;

  joulesPer1kTokens: number;

  totalEnergyWh: number;
  avoidableEnergyWh: number;
  usefulEnergyWh: number;

  heatGeneratedWh: number;
  avoidableHeatWh: number;
  usefulHeatWh: number;

  deploymentMode: DeploymentMode;

  infrastructureBurdenIndex: number;

  caveat: string;
};

export function calculateResourceLedger(input: {
  totalTokens: number;
  wastedTokens: number;
  totalCostUsd?: number;
  wastedCostUsd?: number;
  totalLatencyMs?: number;
  wastedLatencyMs?: number;
  joulesPer1kTokens: number;
  deploymentMode: DeploymentMode;
}): ResourceLedger {
  const totalTokens = Math.max(0, input.totalTokens);
  const wastedTokens = Math.max(0, Math.min(input.wastedTokens, totalTokens));
  const joulesPer1kTokens = Math.max(0, input.joulesPer1kTokens);

  // Wh = (tokens / 1000) * joules-per-1k / 3600 (joules -> watt-hours)
  const totalEnergyWh = (totalTokens / 1000) * joulesPer1kTokens / 3600;
  const avoidableEnergyWh = (wastedTokens / 1000) * joulesPer1kTokens / 3600;
  const usefulEnergyWh = Math.max(totalEnergyWh - avoidableEnergyWh, 0);

  // Heat is modeled 1:1 with energy drawn (energy in -> heat out).
  const heatGeneratedWh = totalEnergyWh;
  const avoidableHeatWh = avoidableEnergyWh;
  const usefulHeatWh = usefulEnergyWh;

  const wasteFraction = totalTokens > 0 ? wastedTokens / totalTokens : 0;

  const baseWasteScore = wasteFraction * 100;
  const deploymentMultiplier = DEPLOYMENT_BURDEN_MULTIPLIER[input.deploymentMode];
  const infrastructureBurdenIndex = Math.min(
    100,
    baseWasteScore * deploymentMultiplier,
  );

  return {
    totalTokens,
    wastedTokens,
    wasteFraction,
    totalCostUsd: input.totalCostUsd,
    wastedCostUsd: input.wastedCostUsd,
    totalLatencyMs: input.totalLatencyMs,
    wastedLatencyMs: input.wastedLatencyMs,
    joulesPer1kTokens,
    totalEnergyWh,
    avoidableEnergyWh,
    usefulEnergyWh,
    heatGeneratedWh,
    avoidableHeatWh,
    usefulHeatWh,
    deploymentMode: input.deploymentMode,
    infrastructureBurdenIndex,
    caveat: REQUIRED_LEDGER_CAVEAT,
  };
}

// Per-mode interpretation copy. Directional context only — not engineering
// guidance and not a physical thermal model.
export const DEPLOYMENT_INTERPRETATION: Record<DeploymentMode, string> = {
  earth_datacenter:
    "Detected inference waste becomes avoidable cost, latency, and cooling load. " +
    "Remaining useful compute heat may only be reusable if the facility has " +
    "compatible liquid cooling, heat pumps, or nearby heat demand.",
  edge_robotics:
    "Waste reduces battery life, increases thermal stress, and can limit autonomy. " +
    "The useful metric is not just cost; it is useful output per watt-hour.",
  orbital_compute:
    "In orbit, unreused heat must eventually be rejected through thermal-control " +
    "systems. This mode treats waste as pressure on thermal headroom, not as an " +
    "exact radiator design.",
  mars_habitat:
    "On Mars, compute heat may have more reuse value because habitats, greenhouses, " +
    "batteries, and water systems may need heat. This estimate does not model a " +
    "real Mars thermal loop.",
};

// Waste findings model (PRD §10). Used by RootCauseDiagnosis and PreventionPlan.
export type WasteFindingType =
  | "repeated_context"
  | "tool_output_bloat"
  | "retry_loop"
  | "planning_loop"
  | "model_overkill"
  | "cache_miss"
  | "duplicate_tool_call";

export type WasteFinding = {
  id: string;
  type: WasteFindingType;
  title: string;
  summary: string;
  affectedSteps: number[];
  totalTokensInvolved: number;
  wastedTokens: number;
  estimatedCostWasteUsd?: number;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  recommendation: string;
};
