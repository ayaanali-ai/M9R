/**
 * Safe run-linkage diagnostic (read-only)
 * ----------------------------------------------------------------------------
 * Checks ONLY the facts needed to explain why a two-run compare can or cannot
 * read Rule Health / behavior for a given later run. It prints booleans and
 * counts — never session content, tokens, env values, or service keys.
 *
 * Usage:
 *   npm run diagnose:run -- <runId>
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (or in .env.local / .env). Those values are read but NEVER printed.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

/** Load KEY=VALUE pairs from a dotenv file into process.env without echoing them. */
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

async function main(): Promise<number> {
  const runId = (process.argv[2] || "").trim();
  if (!runId) {
    console.error("Usage: npm run diagnose:run -- <runId>");
    return 1;
  }

  loadEnvFile(resolve(process.cwd(), ".env.local"));
  loadEnvFile(resolve(process.cwd(), ".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (not printed).");
    return 1;
  }
  const db = createClient(url, key);

  const present = (v: unknown) => (v === null || v === undefined ? false : true);

  // --- agent_runs row -------------------------------------------------------
  let runExists = false;
  let rulesLoadedCount: number | null = null;
  let latestSessionIdPresent = false;
  let runRuleHealthPresent = false;
  let runBehaviorPresent = false;
  let runOptionalColumnsMissing = false;
  let latestSessionId: string | null = null;

  const full = await db
    .from("agent_runs")
    .select("id, rules_loaded_count, latest_session_id, rule_health, behavior")
    .eq("id", runId)
    .maybeSingle();

  if (full.error && (full.error.code === "42703" || /column .* does not exist/i.test(full.error.message ?? ""))) {
    runOptionalColumnsMissing = true;
    const core = await db
      .from("agent_runs")
      .select("id, rules_loaded_count, latest_session_id")
      .eq("id", runId)
      .maybeSingle();
    if (core.data) {
      runExists = true;
      rulesLoadedCount = (core.data as { rules_loaded_count?: number }).rules_loaded_count ?? null;
      latestSessionId = (core.data as { latest_session_id?: string | null }).latest_session_id ?? null;
      latestSessionIdPresent = present(latestSessionId);
    }
  } else if (full.error) {
    console.error("agent_runs read error:", full.error.code ?? "", full.error.message ?? "(no message)");
    return 1;
  } else if (full.data) {
    const r = full.data as Record<string, unknown>;
    runExists = true;
    rulesLoadedCount = (r.rules_loaded_count as number | undefined) ?? null;
    latestSessionId = (r.latest_session_id as string | null | undefined) ?? null;
    latestSessionIdPresent = present(latestSessionId);
    runRuleHealthPresent = present(r.rule_health);
    runBehaviorPresent = present(r.behavior);
  }

  // --- linked agent_sessions snapshot --------------------------------------
  let sessionExists = false;
  let sessionRuleHealthPresent = false;
  let sessionBehaviorPresent = false;
  let sessionSnapshotColumnsMissing = false;

  if (latestSessionId) {
    const sess = await db
      .from("agent_sessions")
      .select("id, rule_health, behavior")
      .eq("id", latestSessionId)
      .maybeSingle();
    if (sess.error && (sess.error.code === "42703" || /column .* does not exist/i.test(sess.error.message ?? ""))) {
      sessionSnapshotColumnsMissing = true;
      const core = await db.from("agent_sessions").select("id").eq("id", latestSessionId).maybeSingle();
      sessionExists = present(core.data);
    } else if (sess.error) {
      console.error("agent_sessions read error:", sess.error.code ?? "", sess.error.message ?? "(no message)");
    } else if (sess.data) {
      const s = sess.data as Record<string, unknown>;
      sessionExists = true;
      sessionRuleHealthPresent = present(s.rule_health);
      sessionBehaviorPresent = present(s.behavior);
    }
  }

  // --- report (facts only — no content) ------------------------------------
  console.log(`run id: ${runId}`);
  console.log(`run exists: ${runExists}`);
  console.log(`rules_loaded_count: ${rulesLoadedCount === null ? "(none)" : rulesLoadedCount}`);
  console.log(`latest_session_id present: ${latestSessionIdPresent}`);
  console.log(`agent_runs.rule_health present: ${runRuleHealthPresent}`);
  console.log(`agent_runs.behavior present: ${runBehaviorPresent}`);
  console.log(`agent_runs optional columns missing (migration needed): ${runOptionalColumnsMissing}`);
  console.log(`linked session exists: ${sessionExists}`);
  console.log(`agent_sessions.rule_health present: ${sessionRuleHealthPresent}`);
  console.log(`agent_sessions.behavior present: ${sessionBehaviorPresent}`);
  console.log(`agent_sessions snapshot columns missing (migration needed): ${sessionSnapshotColumnsMissing}`);

  const hydratable = runRuleHealthPresent || sessionRuleHealthPresent;
  console.log(`compare can hydrate Rule Health: ${hydratable}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("diagnose-run failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
