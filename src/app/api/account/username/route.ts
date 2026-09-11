import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase as admin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isReviewerDemoAppMetadata } from "@/lib/reviewer-demo-access";
import { validateUsername } from "@/lib/username";

function isUsernameSchemaUnavailable(code: string | undefined) {
  return code === "42703" || code === "PGRST204";
}

export async function PATCH(request: NextRequest) {
  const limited = await enforceRateLimit(request, { routeGroup: "account:username", limit: 10, windowSeconds: 60 });
  if (limited) return limited;
  const auth = await createClient();
  if (!auth || !admin) return NextResponse.json({ error: "Account service unavailable." }, { status: 503 });
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (isReviewerDemoAppMetadata(user.app_metadata)) return NextResponse.json({ error: "Reviewer demo is read-only." }, { status: 403 });

  const body = await request.json().catch(() => null) as { username?: unknown } | null;
  const checked = validateUsername(typeof body?.username === "string" ? body.username : "");
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const { error } = await admin.from("users").upsert({
    id: user.id,
    auth_user_id: user.id,
    email: user.email ?? "",
    name: (user.user_metadata?.name as string | undefined) ?? null,
    username: checked.username,
  }, { onConflict: "id" });
  if (error?.code === "23505") {
    return NextResponse.json({ error: "That username is already taken.", code: "USERNAME_TAKEN" }, { status: 409 });
  }
  if (isUsernameSchemaUnavailable(error?.code)) {
    return NextResponse.json({
      error: "Username changes are temporarily unavailable while the account database is updated.",
      code: "USERNAME_SCHEMA_UNAVAILABLE",
    }, { status: 503 });
  }
  if (error) return NextResponse.json({ error: "Could not update username." }, { status: 500 });

  const { error: metadataError } = await auth.auth.updateUser({ data: { username: checked.username } });
  return NextResponse.json({
    ok: true,
    username: checked.username,
    ...(metadataError ? { warning: "Username saved. Sign out and back in if another screen still shows the old name." } : {}),
  });
}
