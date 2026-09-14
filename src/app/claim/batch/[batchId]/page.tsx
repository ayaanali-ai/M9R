import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AuthDebugBadge from "@/components/AuthDebugBadge";
import ClaimBatchActions from "@/components/ClaimBatchActions";
import { getClaimBatchPublic } from "@/lib/agent-join-service";
import { createClient } from "@/lib/supabase/server";
import { agentLabel, normalizeAgentKind } from "@/lib/agent-workspace-data";

export const dynamic = "force-dynamic";

function fmtExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
}

/** One-click human approval page for a CLI `connect` batch. */
export default async function ClaimBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const batch = await getClaimBatchPublic(batchId);
  const db = await createClient();
  const user = db ? (await db.auth.getUser()).data.user : null;
  const signedIn = Boolean(user);
  const pendingCount = batch?.claims.filter((claim) => claim.status === "pending" && !claim.expired).length ?? 0;

  return (
    <>
      <Nav />
      <AuthDebugBadge />
      <main className="px-6 pt-32">
        <section className="mx-auto max-w-3xl pb-20">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-wider text-lime">Provider connection request</div>
          <h1 className="text-3xl font-bold tracking-tight text-[#f5f0e8] sm:text-4xl">Approve these agent connections?</h1>

          {!batch ? (
            <div className="mt-8 rounded-xl border border-[#222] bg-[#0d0d0d] p-6 text-sm text-muted">
              <p>This connection batch could not be found. It may have expired or been mistyped. Ask the CLI to request a new batch.</p>
              <Link href="/agents" className="mt-4 inline-flex text-lime hover:underline">Learn about agent connections →</Link>
            </div>
          ) : (
            <>
              <div className="mt-6 rounded-xl border border-[#3a2f12] bg-[#15110a] p-4 text-sm leading-relaxed text-[#e8d9b0]">
                Approving this page creates one persistent, workspace-scoped connection per provider below. Each provider receives only its own token; approval does not grant billing, workspace deletion, or access to other people&apos;s sessions.
              </div>
              <div className="mt-8 divide-y divide-[#1a1a1a] rounded-xl border border-[#222] bg-[#0d0d0d]">
                {batch.claims.map((claim) => (
                  <div key={claim.claim_id} className="px-5 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold text-[#f5f0e8]">{agentLabel(normalizeAgentKind(claim.agent_kind))}</h2>
                        <p className="mt-1 font-mono text-[12px] text-muted">{claim.repo_hint}</p>
                      </div>
                      <span className={`rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${claim.status === "pending" && !claim.expired ? "border-lime/30 text-lime" : "border-[#333] text-muted"}`}>
                        {claim.expired && claim.status === "pending" ? "expired" : claim.status}
                      </span>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted">
                      <span>Expires {fmtExpiry(claim.expires_at)}</span>
                      <span>{claim.capabilities.length} capability request{claim.capabilities.length === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-8">
                <ClaimBatchActions batchId={batch.batch_id} signedIn={signedIn} returnTo={`/claim/batch/${batch.batch_id}`} pendingCount={pendingCount} />
              </div>
              <p className="mt-8 text-xs leading-relaxed text-muted">Human-owned, agent-operated. The CLI keeps each provider&apos;s setup code private while this page handles the single human approval decision.</p>
            </>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
