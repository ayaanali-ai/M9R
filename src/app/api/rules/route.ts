import { NextRequest, NextResponse } from "next/server";
import { listRules, createRule, RulesServiceError, type CreateRuleInput } from "@/lib/rules-service";

// ---------------------------------------------------------------------------
// GET /api/rules — list rules for the dashboard.
//
// Query params:
//   q=<text>           free-text filter over title/description/leakType
//   status=active|inactive|all   (default: active)
//
// Identity and owner scope are resolved by the service from the signed-in
// cookie session. Caller-supplied identity headers are intentionally ignored.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get("q") ?? undefined;
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "inactive" || statusParam === "all" ? statusParam : "active";
    const rules = await listRules({ query, status });
    return NextResponse.json({ ok: true, rules });
  } catch (err) {
    if (err instanceof RulesServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("List rules error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/rules — create (persist) a rule from a Blackbox Report.
//
// Body: { title, leakType, severity, description, fixNow?, promptFix?,
//         policyRule?, evidenceNeeded?, evidenceLevel?, sourceReportId? }
//
// Runs as the signed-in user; the service resolves their default project.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    let body: Partial<CreateRuleInput>;
    try {
      body = (await req.json()) as Partial<CreateRuleInput>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Whitelist + coerce the fields we accept (never trust the client shape).
    const severity = body.severity;
    const input: CreateRuleInput = {
      title: String(body.title ?? ""),
      leakType: String(body.leakType ?? "custom"),
      severity: severity === "low" || severity === "high" ? severity : "medium",
      description: String(body.description ?? ""),
      fixNow: typeof body.fixNow === "string" ? body.fixNow : undefined,
      promptFix: typeof body.promptFix === "string" ? body.promptFix : undefined,
      policyRule: typeof body.policyRule === "string" ? body.policyRule : undefined,
      evidenceNeeded: Array.isArray(body.evidenceNeeded)
        ? body.evidenceNeeded.filter((e): e is string => typeof e === "string")
        : undefined,
      evidenceLevel:
        body.evidenceLevel === "Claimed" ||
        body.evidenceLevel === "Correlated" ||
        body.evidenceLevel === "Unprovable"
          ? body.evidenceLevel
          : "Observed",
      sourceReportId: typeof body.sourceReportId === "string" ? body.sourceReportId : null,
    };

    const rule = await createRule(input);
    return NextResponse.json({ ok: true, rule }, { status: 201 });
  } catch (err) {
    if (err instanceof RulesServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Create rule error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
