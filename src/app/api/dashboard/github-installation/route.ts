import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGithubInstallationForWorkspace, deleteGithubInstallationForWorkspace } from "@/lib/github-installation-store";

async function currentWorkspaceId(): Promise<string | null> {
  const db = await createClient();
  if (!db) return null;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data: workspace } = await db.from("projects").select("id").eq("owner_id", user.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (workspace?.id as string | undefined) ?? null;
}

export async function GET() {
  const workspaceId = await currentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ installation: null, workspaceId: null });
  const installation = await getGithubInstallationForWorkspace(workspaceId);
  return NextResponse.json({ installation, workspaceId });
}

export async function DELETE() {
  const workspaceId = await currentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  await deleteGithubInstallationForWorkspace(workspaceId);
  return NextResponse.json({ ok: true });
}
