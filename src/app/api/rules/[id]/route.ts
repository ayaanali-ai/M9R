import { NextRequest, NextResponse } from "next/server";
import { updateRule, deleteRule, RulesServiceError, type RuleUpdate } from "@/lib/rules-service";

// ---------------------------------------------------------------------------
// PATCH /api/rules/[id] — edit a rule or toggle is_active (deactivate).
// DELETE /api/rules/[id] — soft-delete a rule.
//
// Dynamic params are async in this Next version (await ctx.params).
// ---------------------------------------------------------------------------

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    let body: Partial<RuleUpdate>;
    try {
      body = (await req.json()) as Partial<RuleUpdate>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Whitelist editable fields so callers can't write arbitrary columns.
    const patch: RuleUpdate = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.fixNow === "string") patch.fixNow = body.fixNow;
    if (body.severity === "low" || body.severity === "medium" || body.severity === "high") {
      patch.severity = body.severity;
    }
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No editable fields provided." }, { status: 400 });
    }

    const rule = await updateRule(id, patch);
    return NextResponse.json({ ok: true, rule });
  } catch (err) {
    if (err instanceof RulesServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Update rule error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteRule(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RulesServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Delete rule error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
