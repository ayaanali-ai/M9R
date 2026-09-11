import { NextResponse } from "next/server";
import { listConnectedAgentsForDashboard } from "@/lib/agent-join-service";
import { handleDashboardApiError } from "../_shared";

export const dynamic = "force-dynamic";

// GET /api/dashboard/connections — this human's active agent connections,
// for the Settings "Connected agents" section. Cookie-authenticated.
export async function GET() {
  try {
    const connections = await listConnectedAgentsForDashboard();
    return NextResponse.json({ connections }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
