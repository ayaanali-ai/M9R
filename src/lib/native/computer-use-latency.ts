import type { ComputerUseTelemetry } from "./computer-use-contract";

/** Engineering budgets, not timeouts: crossing one must never replay input. */
export const COMPUTER_USE_LATENCY_BUDGET_MS = Object.freeze({ observationMs: 2_000, routingMs: 25, actionMs: 2_000, verificationMs: 25, totalMs: 5_000 });
type Phase = keyof typeof COMPUTER_USE_LATENCY_BUDGET_MS;
const samples: { timingsMs: Partial<Record<Phase, number>>; exceeded: Phase[]; priorReceiptFound: boolean }[] = [];

/** Process-local and bounded. No target, app, text, provider or user identifiers. */
export function recordComputerUseLatency(telemetry: ComputerUseTelemetry): void {
  const timingsMs: Partial<Record<Phase, number>> = {};
  const exceeded: Phase[] = [];
  for (const phase of Object.keys(COMPUTER_USE_LATENCY_BUDGET_MS) as Phase[]) {
    const value = telemetry.timingsMs[phase];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    timingsMs[phase] = value;
    if (value > COMPUTER_USE_LATENCY_BUDGET_MS[phase]) exceeded.push(phase);
  }
  samples.push({ timingsMs, exceeded, priorReceiptFound: telemetry.priorReceiptFound });
  if (samples.length > 256) samples.shift();
}

/** Internal diagnostics only; never registered as an agent tool. */
export function computerUseLatencySnapshot() {
  return samples.map((sample) => ({ ...sample, timingsMs: { ...sample.timingsMs }, exceeded: [...sample.exceeded] }));
}
