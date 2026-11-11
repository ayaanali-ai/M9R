import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Item 7 of the latency plan: observeDesktop() already defaults to a structured (tree-only)
// observation and only attaches a screenshot when the UI Automation tree itself reports it
// can't answer. This ledger is pure visibility into that existing, unchanged decision -- a
// tiny local-only counter, never prompts/page content/images, persisted so the owner can
// inspect real numbers from a running session with `m9r-cli observation-stats`, the same way
// workflow-preferences.ts persists its own small local counts.

export type ObservationModalityOutcome = "explicit-visual" | "tree-incomplete-fallback" | "tree-only";
export interface ObservationModalitySnapshot {
  observations: number;
  explicitVisual: number;
  treeIncompleteFallback: number;
  treeOnly: number;
  updatedAt?: string;
}
export interface ObservationModalityLedger {
  record(outcome: ObservationModalityOutcome): void;
  snapshot(): ObservationModalitySnapshot;
}

const FILE_NAME = "observation-modality-stats.json";

function validSnapshot(value: unknown): value is ObservationModalitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["observations", "explicitVisual", "treeIncompleteFallback", "treeOnly"].every(
    (key) => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0,
  );
}

export function createObservationModalityLedger(root: string, now: () => Date = () => new Date()): ObservationModalityLedger {
  const path = join(root, FILE_NAME);
  let state: ObservationModalitySnapshot = { observations: 0, explicitVisual: 0, treeIncompleteFallback: 0, treeOnly: 0 };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (validSnapshot(parsed)) state = { ...parsed };
  } catch { /* missing or malformed memory is intentionally treated as empty */ }
  let pending = Promise.resolve();
  const persist = () => {
    const temp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch { try { unlinkSync(temp); } catch { /* best effort */ } }
  };
  return {
    record(outcome) {
      state = {
        ...state,
        observations: state.observations + 1,
        explicitVisual: state.explicitVisual + (outcome === "explicit-visual" ? 1 : 0),
        treeIncompleteFallback: state.treeIncompleteFallback + (outcome === "tree-incomplete-fallback" ? 1 : 0),
        treeOnly: state.treeOnly + (outcome === "tree-only" ? 1 : 0),
        updatedAt: now().toISOString(),
      };
      pending = pending.then(persist, persist);
    },
    snapshot() { return { ...state }; },
  };
}
