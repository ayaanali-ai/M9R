import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { PageHeader, Surface, Meta, StatusLozenge, ListRow, type LozengeTone } from "@/components/product/WorkspaceUI";

export const dynamic = "force-dynamic";

const RISK_TONE: Record<string, LozengeTone> = { high: "danger", medium: "warn", low: "neutral" };

/**
 * Discoverable cookie-authenticated inbox for bearer-created run approvals.
 * The detail page remains the decision authority; this is deliberately only a
 * workspace-scoped index so a lost CLI deep-link never creates a dead end.
 */
export default async function ApprovalRequestsPage() {
  const db = await createClient();
  if (!db) return <ApprovalStatus title="M9R is not configured." body="This deployment has no database connection configured." />;
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/approvals");

  const workspaceId = await resolveActiveOrDefaultProjectId(db, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });
  if (!supabase) return <ApprovalStatus title="Approval requests unavailable" body="The server-side approval store is not configured." />;

  const { data, error } = await supabase
    .from("approval_requests")
    .select("id, operation_type, risk_classification, status, created_at, expires_at")
    .eq("workspace_id", workspaceId)
    // The real status vocabulary is "pending" and "consumed" (set once a
    // decision is recorded) -- "approved"/"rejected" never existed as stored
    // values, so this filter was silently hiding every decided request (11
    // of 13 rows in production). ApprovalRow only checks `=== "pending"` to
    // decide which section a row lands in, so "consumed" needs no further
    // handling once it's let through here.
    .in("status", ["pending", "consumed"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return <ApprovalStatus title="Approval requests unavailable" body="Could not load this workspace's approval requests." />;

  const requests = data ?? [];
  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="product-page-shell">
      <PageHeader eyebrow="Decisions" title="Run Approvals" description="Pending requests require a signed-in workspace owner." />
      <Surface className="mt-6 overflow-hidden" style={{ borderRadius: "var(--ol-radius-lg)" }}>
        {requests.length === 0 ? (
          <p className="p-5 text-sm text-[color:var(--ol-text-muted)]">No recent run approval requests.</p>
        ) : (
          <>
            {pending.length > 0 && (
              <div className="border-b border-[color:var(--ol-border-subtle)] px-4 py-2 ol-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--ol-text-muted)]">
                Pending · {pending.length}
              </div>
            )}
            <ul className="divide-y divide-[color:var(--ol-border-subtle)]">
              {pending.map((request) => <ApprovalRow key={request.id} request={request} pending />)}
            </ul>
            {decided.length > 0 && (
              <>
                <div className="border-y border-[color:var(--ol-border-subtle)] px-4 py-2 ol-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--ol-text-muted)]">
                  Decided · {decided.length}
                </div>
                <ul className="divide-y divide-[color:var(--ol-border-subtle)]">
                  {decided.map((request) => <ApprovalRow key={request.id} request={request} pending={false} />)}
                </ul>
              </>
            )}
          </>
        )}
      </Surface>
    </div>
  );
}

function ApprovalRow({
  request,
  pending,
}: {
  request: { id: string; operation_type: string; risk_classification: string; status: string; expires_at: string };
  pending: boolean;
}) {
  return (
    <ListRow as="li" className={`flex-wrap p-4 ${pending ? "border-l-2 border-[color:var(--ol-warn)]" : ""}`}>
      <Link
        href={`/dashboard/approvals/${encodeURIComponent(request.id)}`}
        className={`min-w-0 flex-1 hover:underline ${pending ? "text-[color:var(--ol-text-primary)]" : "text-[color:var(--ol-text-secondary)]"}`}
      >
        <span className="block truncate text-sm font-medium">{request.operation_type}</span>
        <Meta className="mt-1">
          <span>{pending ? "awaiting decision" : request.status}</span>
          <span>expires {new Date(request.expires_at).toLocaleString()}</span>
        </Meta>
      </Link>
      <StatusLozenge tone={RISK_TONE[request.risk_classification] ?? "neutral"}>{request.risk_classification}</StatusLozenge>
    </ListRow>
  );
}

function ApprovalStatus({ title, body }: { title: string; body: string }) {
  return (
    <div className="product-page-shell">
      <PageHeader eyebrow="Decisions" title={title} description={body} />
    </div>
  );
}
