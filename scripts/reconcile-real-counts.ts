/**
 * Real-count reconciliation (read-only)
 * ----------------------------------------------------------------------------
 * Prints the actual current totals for agent_runs, retained run events, and
 * bounded assignments, straight from the database — count-only queries, no
 * row content ever fetched or printed. Exists because two different figures
 * (an internal "1 run" spot-check and an external "165 runs" claim) were both
 * circulating without either being a real, current count. This script is the
 * one source of truth going forward; run it again before publishing any
 * proof-of-product material so the number is never stale.
 *
 * Usage: npm run reconcile:counts
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read from
 * .env.local / .env, never printed).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- standalone script, no shared SupabaseClient generic to reuse here
async function countRows(db: any, table: string): Promise<{ count: number | null; missing: boolean }> {
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true });
  if (error) {
    const missing = error.code === "42P01" || /relation .* does not exist/i.test(error.message ?? "");
    if (!missing) console.error(`${table} count error:`, error.code ?? "", error.message ?? "(no message)");
    return { count: null, missing };
  }
  return { count: count ?? 0, missing: false };
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

  const [runs, events, assignments, adoptions] = await Promise.all([
    countRows(db, "agent_runs"),
    countRows(db, "agent_run_events"),
    countRows(db, "agent_assignments"),
    countRows(db, "result_adoptions"),
  ]);

  console.log("Real current counts (as of now, this database):");
  console.log(`  agent_runs:        ${runs.missing ? "(table not found)" : runs.count}`);
  console.log(`  agent_run_events:  ${events.missing ? "(table not found)" : events.count}`);
  console.log(`  agent_assignments: ${assignments.missing ? "(table not found)" : assignments.count}`);
  console.log(`  result_adoptions:  ${adoptions.missing ? "(table not found)" : adoptions.count}`);
  console.log("");
  console.log("Neither the '1 run' internal spot-check nor the '165 runs' external figure should be");
  console.log("treated as current — use the numbers above, re-run this script before publishing any");
  console.log("proof-of-product material, and cite whichever number was actually printed just now.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("reconcile-real-counts failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
