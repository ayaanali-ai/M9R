import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { getApprovalRequest } from "@/lib/approval-requests";

export const dynamic = "force-dynamic";

/**
 * /dashboard/approvals/[id] — deep-link destination for the bearer 403's
 * `dashboardPath`. This used to render its own separate decision form; now
 * there's exactly one approval experience (the inline card in the message
 * feed, same as evidence/finding/rule decisions), so this route's only job
 * is to resolve which conversation+message that card lives under and send
 * the human straight there. Cookie-authenticated, workspace-scoped: a
 * cross-workspace id (or one that doesn't exist) falls through to the
 * Watchfloor with no distinct error, never leaking existence across
 * workspaces.
 */
export default async function ApprovalRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const db = await createClient();
  if (!db) redirect("/dashboard/agents");
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=/dashboard/approvals/${encodeURIComponent(id)}`);

  const workspaceId = await resolveActiveOrDefaultProjectId(db, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });

  const request = await getApprovalRequest(id, workspaceId);
  const requestMessageId = typeof request?.requestSummary.requestMessageId === "string" ? request.requestSummary.requestMessageId : null;
  // Older requests (predating the inline-card feature) never got a message
  // id attached -- best-effort fall through to the Watchfloor generally
  // rather than a dead-end page.
  if (!requestMessageId) redirect("/dashboard/agents");

  const { data: message } = await db.from("conversation_messages").select("conversation_id").eq("id", requestMessageId).maybeSingle();
  const conversationId = (message?.conversation_id as string | undefined) ?? null;
  if (!conversationId) redirect("/dashboard/agents");

  redirect(`/dashboard/agents?conversation=${encodeURIComponent(conversationId)}&message=${encodeURIComponent(requestMessageId)}`);
}
