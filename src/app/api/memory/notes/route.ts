import { NextRequest, NextResponse } from "next/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { listSyncedNotesForUser, saveSyncedNoteForUser } from "@/lib/shared-memory-service";
import { resolveUserApiToken } from "@/lib/user-api-token-service";

export const dynamic = "force-dynamic";

/**
 * Shared memory for a person's own M9R install (the local broker and desktop pill), authenticated by a personal API token
 * from Settings > API tokens. GET returns the reviewed workspace notes agents should read; POST saves one.
 */
async function userFrom(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  if (!match) return NextResponse.json({ error: "Missing bearer token. Create one in M9R under Settings > API tokens." }, { status: 401 });
  const resolved = await resolveUserApiToken(match[1].trim());
  if (!resolved) return NextResponse.json({ error: "Invalid or revoked API token." }, { status: 401 });
  return resolved;
}

function failure(error: unknown) {
  if (error instanceof AgentJoinError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const user = await userFrom(req);
  if (user instanceof NextResponse) return user;
  try {
    return NextResponse.json({ notes: await listSyncedNotesForUser(user.userId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  const user = await userFrom(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null) as { title?: unknown; body?: unknown; propose?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Invalid memory note." }, { status: 400 });
  try {
    return NextResponse.json(await saveSyncedNoteForUser(user.userId, { title: body.title, body: body.body }, body.propose === true));
  } catch (error) { return failure(error); }
}
