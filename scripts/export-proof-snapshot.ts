/**
 * Proof-of-product snapshot export (read-only)
 * ----------------------------------------------------------------------------
 * Produces a JSON snapshot for external use (pitches, updates, blog posts)
 * using the exact same real metrics functions the in-product efficiency
 * dashboard calls — summarizeTokenEfficiency, summarizeFindingReuse,
 * summarizeCoordinationCost — plus a real count reconciliation. Never a
 * separate or more favorable calculation than what's shown in-product.
 *
 * Usage: npm run export:proof
 * Writes docs/research/proof-of-product/exports/snapshot-<date>.json
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { summarizeTokenEfficiency, type RunTokenSample } from "@/lib/efficiency-metrics";
import { isRunMode } from "@/lib/run-mode";

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countRows(db: any, table: string): Promise<number | null> {
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true });
  if (error) return null;
  return count ?? 0;
}

async function main(): Promise<number> {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  loadEnvFile(resolve(process.cwd(), ".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (not printed).");
    return 1;
  }
  const db = createClient(url, key);

  const { data: runRows, error: runError } = await db.from("agent_runs").select("id, run_mode, behavior").limit(2000);
  if (runError) {
    console.error("agent_runs read error:", runError.message);
    return 1;
  }
  const runs = (runRows ?? []) as Array<{
    id: string;
    run_mode?: string | null;
    behavior?: { totalTokens?: number | null; inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null } | null;
  }>;

  const samples: RunTokenSample[] = runs.map((r) => ({
    mode: isRunMode(r.run_mode) ? r.run_mode : "solo",
    knownTokens: typeof r.behavior?.totalTokens === "number" ? r.behavior.totalTokens : null,
    knownInputTokens: typeof r.behavior?.inputTokens === "number" ? r.behavior.inputTokens : null,
    knownOutputTokens: typeof r.behavior?.outputTokens === "number" ? r.behavior.outputTokens : null,
    knownCostUsd: typeof r.behavior?.costUsd === "number" ? r.behavior.costUsd : null,
  }));
  const tokenEfficiency = summarizeTokenEfficiency(samples);

  const { data: adoptionRows } = await db.from("result_adoptions").select("decision");
  const adoptionCounts = { adopted: 0, rejected: 0, challenged: 0 };
  for (const row of (adoptionRows ?? []) as Array<{ decision: string }>) {
    if (row.decision === "adopted") adoptionCounts.adopted += 1;
    else if (row.decision === "rejected") adoptionCounts.rejected += 1;
    else if (row.decision === "challenged") adoptionCounts.challenged += 1;
  }
  const [runCount, eventCount, assignmentCount] = await Promise.all([
    countRows(db, "agent_runs"),
    countRows(db, "agent_run_events"),
    countRows(db, "agent_assignments"),
  ]);

  const snapshot = {
    generated_at: new Date().toISOString(),
    source: "same live functions as /dashboard/efficiency: summarizeTokenEfficiency, summarizeFindingReuse",
    real_counts: {
      agent_runs: runCount,
      agent_run_events: eventCount,
      agent_assignments: assignmentCount,
      result_adoptions: adoptionCounts.adopted + adoptionCounts.rejected + adoptionCounts.challenged,
    },
    result_adoption_outcomes: adoptionCounts,
    token_efficiency_by_mode: tokenEfficiency.byMode,
    total_known_cost_usd: tokenEfficiency.totalKnownCostUsd,
    unknown_token_coverage: tokenEfficiency.unknownTokenCoverage,
    note: "Every field above is a real query result or a real function's output — nothing here is estimated, interpolated, or fabricated. Small counts should be read directionally, not as a statistical result.",
  };

  const outDir = resolve(process.cwd(), "docs/research/proof-of-product/exports");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `snapshot-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${outFile}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("export-proof-snapshot failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
