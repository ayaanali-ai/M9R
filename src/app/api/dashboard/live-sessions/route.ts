import { NextResponse } from "next/server";
import { syncAndListOpenSessions } from "@/lib/bridge/session-service";
import { handleDashboardApiError } from "../_shared";

// YC "Multiplayer AI" RFS: every Session currently open anywhere in the
// workspace (active or waiting), so a human can drop into one they aren't
// already sitting in. GET only -- this is a read/discovery surface, not an
// action. See M9R_MASTER_BUILD_PLAN.md item 1.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await syncAndListOpenSessions();
    return NextResponse.json({ sessions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
