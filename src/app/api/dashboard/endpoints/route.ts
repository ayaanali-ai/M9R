import { NextResponse } from "next/server";
import { dashboardWorkspaceContext } from "@/lib/dashboard-workspace-context";
import { loadWorkspaceEndpointsForHuman, viewOf } from "@/lib/endpoint-service";
import { supabase } from "@/lib/supabase";

export async function GET() {
  const context = await dashboardWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const loaded = await loadWorkspaceEndpointsForHuman(context.workspaceId, context.userId);
    const machineByConnection = new Map<string, string>();
    if (supabase) {
      const { data } = await supabase.from("native_devices").select("connection_id, device_id")
        .eq("workspace_id", context.workspaceId).is("revoked_at", null);
      for (const machine of data ?? []) machineByConnection.set(String(machine.connection_id), String(machine.device_id));
    }
    return NextResponse.json({ endpoints: loaded.rows.map((row) => ({ ...viewOf(row, loaded),
      machineId: row.current_connection_id ? machineByConnection.get(row.current_connection_id) ?? null : null,
    })) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load endpoints." }, { status: 500 });
  }
}
