import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_BUDGETS } from "@/lib/agent-usage";
import { normalizeAgentKind } from "@/lib/agent-workspace-data";

/**
 * GET/PUT /api/agent/usage-budgets — the human-set token budgets the Live
 * Sessions floor measures 5H/7D usage against. Cookie-authenticated and
 * owner-scoped (RLS on agent_usage_budgets), same trust model as the other
 * dashboard routes — never the agent-token API.
 */

const MAX_BUDGET_TOKENS = 10_000_000_000;

export async function GET() {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data, error } = await db
    .from("agent_usage_budgets")
    .select("agent_kind, window_5h_tokens, window_7d_tokens")
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "Could not read budgets." }, { status: 500 });
  return NextResponse.json({ budgets: data ?? [], defaults: DEFAULT_BUDGETS });
}

export async function PUT(req: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { agentKind?: string; window5hTokens?: number; window7dTokens?: number }
    | null;
  if (!body?.agentKind) return NextResponse.json({ error: "agentKind is required." }, { status: 400 });
  const agentKind = normalizeAgentKind(body.agentKind);

  const patch: Record<string, number> = {};
  for (const [column, value] of [
    ["window_5h_tokens", body.window5hTokens],
    ["window_7d_tokens", body.window7dTokens],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0 || value > MAX_BUDGET_TOKENS) {
      return NextResponse.json({ error: "Budgets must be a positive token count." }, { status: 400 });
    }
    patch[column] = Math.round(value);
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { error } = await db
    .from("agent_usage_budgets")
    .upsert(
      { user_id: user.id, agent_kind: agentKind, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id,agent_kind" },
    );
  if (error) {
    // 42P01: table missing — the migration hasn't been applied to this database.
    const migrationRequired = error.code === "42P01";
    return NextResponse.json(
      { error: migrationRequired ? "Budget storage is not migrated yet (agent_usage_budgets missing)." : "Could not save budget." },
      { status: migrationRequired ? 503 : 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
