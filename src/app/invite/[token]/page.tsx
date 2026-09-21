import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import InviteAcceptClient from "@/components/product/InviteAcceptClient";

export const dynamic = "force-dynamic";

/**
 * /invite/[token] — accept a workspace invite. Signed-out visitors are sent
 * to sign in first and land back here (safeRelativePath's own `next` param
 * convention, same as every other post-auth destination in this app).
 * Acceptance itself (email match, expiry, already-accepted) happens
 * server-side in acceptWorkspaceInvite -- this page only decides whether a
 * session exists yet to call it with.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = await createClient();
  const { data } = db ? await db.auth.getUser() : { data: { user: null } };
  if (!data.user) redirect(`/?invite=${encodeURIComponent(token)}`);

  return (
    <main className="auth-min-shell">
      <InviteAcceptClient token={token} />
    </main>
  );
}
