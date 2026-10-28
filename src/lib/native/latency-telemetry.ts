/** Phase 9 bounded latency telemetry. It stores durations only, never prompts or provider payloads. */

export type LatencySampleKind = "dispatch_to_first_action" | "action_completion";
export type LatencyTemperature = "cold" | "warm";

export interface LatencySample {
  readonly kind: LatencySampleKind;
  readonly temperature: LatencyTemperature;
  readonly durationMs: number;
  readonly status: "ok" | "error";
}

export interface LatencyPercentiles {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface LatencyTelemetrySnapshot {
  readonly dispatchToFirstAction: Readonly<Record<LatencyTemperature, LatencyPercentiles>>;
  readonly actionCompletion: Readonly<Record<LatencyTemperature, LatencyPercentiles>>;
}

export interface LatencyTelemetry {
  record(sample: LatencySample): void;
  snapshot(): LatencyTelemetrySnapshot;
  reset(): void;
}

const temperatures: readonly LatencyTemperature[] = ["cold", "warm"];
const kinds: readonly LatencySampleKind[] = ["dispatch_to_first_action", "action_completion"];

function emptyPercentiles(): LatencyPercentiles {
  return { count: 0, p50Ms: null, p95Ms: null };
}

function percentile(values: readonly number[], fraction: number): number {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return values[index]!;
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 60_000;
}

export function createLatencyTelemetry(options: { readonly maxSamples?: number } = {}): LatencyTelemetry {
  const maxSamples = options.maxSamples ?? 256;
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 8 || maxSamples > 4096) throw new Error("Latency sample bound is invalid.");
  const samples = new Map<string, number[]>();

  const key = (kind: LatencySampleKind, temperature: LatencyTemperature): string => `${kind}:${temperature}`;
  const read = (kind: LatencySampleKind, temperature: LatencyTemperature): LatencyPercentiles => {
    const values = [...(samples.get(key(kind, temperature)) ?? [])].sort((a, b) => a - b);
    if (values.length === 0) return emptyPercentiles();
    return { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
  };

  return {
    record(sample) {
      if (!kinds.includes(sample.kind) || !temperatures.includes(sample.temperature) || !validDuration(sample.durationMs)) return;
      const list = samples.get(key(sample.kind, sample.temperature)) ?? [];
      list.push(Math.round(sample.durationMs));
      while (list.length > maxSamples) list.shift();
      samples.set(key(sample.kind, sample.temperature), list);
    },
    snapshot() {
      return {
        dispatchToFirstAction: { cold: read("dispatch_to_first_action", "cold"), warm: read("dispatch_to_first_action", "warm") },
        actionCompletion: { cold: read("action_completion", "cold"), warm: read("action_completion", "warm") },
      };
    },
    reset() { samples.clear(); },
  };
}

