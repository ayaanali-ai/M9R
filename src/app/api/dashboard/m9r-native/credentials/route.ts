import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import {
  storeProviderCredential,
  listProviderCredentialMetadata,
  deleteProviderCredential,
} from "@/lib/mission/m9r-native-credential-service";

/**
 * Item #32: dashboard-facing CRUD for a workspace's own model-provider
 * credentials (M9R's first-party any-model harness). Never returns a
 * decrypted value -- GET returns metadata only (which providers are
 * connected, never the key itself), matching the same "connected, added
 * <date>, never the value again" posture the plan calls for.
 */

async function requireWorkspace() {
  const auth = await createClient();
  if (!auth) throw new Error("Authentication is unavailable.");
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Sign in required.");
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, { id: user.id, email: user.email, name: null });
  if (!workspaceId) throw new Error("No workspace is available for this account.");
  return { userId: user.id, workspaceId };
}

export async function GET() {
  try {
    const { workspaceId } = await requireWorkspace();
    const credentials = await listProviderCredentialMetadata(workspaceId);
    return NextResponse.json({ credentials });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not list credentials." }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, workspaceId } = await requireWorkspace();
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const providerEnvVar = typeof body.providerEnvVar === "string" ? body.providerEnvVar : "";
    if (!providerEnvVar) return NextResponse.json({ error: "providerEnvVar is required." }, { status: 400 });
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!secret.trim()) return NextResponse.json({ error: "secret is required." }, { status: 400 });

    // storeProviderCredential validates providerEnvVar against the real,
    // live catalog itself and throws a clear error if unsupported -- no
    // duplicate check needed here.
    await storeProviderCredential({ workspaceId, providerEnvVar, secret, createdByUserId: userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not store the credential." }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace();
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const providerEnvVar = typeof body.providerEnvVar === "string" ? body.providerEnvVar : "";
    if (!providerEnvVar) return NextResponse.json({ error: "providerEnvVar is required." }, { status: 400 });

    await deleteProviderCredential(workspaceId, providerEnvVar);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not delete the credential." }, { status: 400 });
  }
}
