import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listFindingsForUser, countAdoptions } from "@/lib/finding-service";
import {
  summarizeTokenEfficiency,
  summarizeFindingReuse,
  summarizeCoordinationCost,
  type RunTokenSample,
} from "@/lib/efficiency-metrics";
import { isRunMode } from "@/lib/run-mode";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/efficiency — the Phase 11 report: known-token coverage by
// Run Mode, Finding reuse rate, and coordination requests that went
// unresolved. Cookie-authenticated, RLS-scoped. Every number here is a real
// count — no savings percentage is invented (efficiency-metrics.ts).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const REQUEST_TYPES = ["HELP_REQUESTED", "CHECK_REQUESTED"];

export async function GET() {
  try {
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const { data: runRows, error: runError } = await db.from("agent_runs").select("id, run_mode, behavior").limit(500);
    if (runError && runError.code !== "42703" && !/column .* does not exist/i.test(runError.message ?? "")) throw runError;
    const runs = (runRows ?? []) as Array<{ id: string; run_mode?: string | null; behavior?: { totalTokens?: number | null; inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null } | null }>;

    const samples: RunTokenSample[] = runs.map((r) => ({
      mode: isRunMode(r.run_mode) ? r.run_mode : "solo",
      knownTokens: typeof r.behavior?.totalTokens === "number" ? r.behavior.totalTokens : null,
      knownInputTokens: typeof r.behavior?.inputTokens === "number" ? r.behavior.inputTokens : null,
      knownOutputTokens: typeof r.behavior?.outputTokens === "number" ? r.behavior.outputTokens : null,
      knownCostUsd: typeof r.behavior?.costUsd === "number" ? r.behavior.costUsd : null,
    }));
    const tokenReport = summarizeTokenEfficiency(samples);

    const availableFindings = await listFindingsForUser({ onlyAvailable: true });
    const adoptionCounts = await Promise.all(availableFindings.map((f) => countAdoptions(f.id)));
    const findingReuseReport = summarizeFindingReuse(adoptionCounts.map((c) => ({ adoptedCount: c.totalAdoptions })));

    const runIds = runs.map((r) => r.id);
    let coordinationReport = { coordinatedOrAssuranceRuns: 0, unresolvedCoordinationRuns: 0 };
    if (runIds.length > 0) {
      const { data: dispatchRows, error: dispatchError } = await db
        .from("dispatches")
        .select("run_id, type, resolution_state")
        .in("run_id", runIds)
        .in("type", REQUEST_TYPES);
      if (!dispatchError) {
        const byRun = new Map<string, { issued: number; resolved: number }>();
        for (const row of (dispatchRows ?? []) as Array<{ run_id: string; resolution_state: string }>) {
          const entry = byRun.get(row.run_id) ?? { issued: 0, resolved: 0 };
          entry.issued += 1;
          if (row.resolution_state === "resolved") entry.resolved += 1;
          byRun.set(row.run_id, entry);
        }
        const coordinationRuns = runs.map((r) => {
          const usage = byRun.get(r.id) ?? { issued: 0, resolved: 0 };
          return { mode: isRunMode(r.run_mode) ? r.run_mode : ("solo" as const), requestsIssued: usage.issued, requestsResolved: usage.resolved };
        });
        coordinationReport = summarizeCoordinationCost(coordinationRuns);
      }
    }

    return NextResponse.json({ tokenEfficiency: tokenReport, findingReuse: findingReuseReport, coordinationCost: coordinationReport });
  } catch (err) {
    return handleAgentError(err);
  }
}
