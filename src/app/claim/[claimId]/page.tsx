import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ClaimActions from "@/components/ClaimActions";
import AuthDebugBadge from "@/components/AuthDebugBadge";
import { getClaimPublic } from "@/lib/agent-join-service";
import { createClient } from "@/lib/supabase/server";
import { agentLabel, normalizeAgentKind } from "@/lib/agent-workspace-data";

/**
 * /claim/[claimId] — the human approval page.
 *
 * Shows the agent's requested connection (repo hint, agent kind, requested
 * capabilities + scopes, expiration) and a clear warning. A signed-in human can
 * approve (binding the connection to a workspace they own) or reject. No
 * connection or token exists until approval — that's the whole point.
 */

export const dynamic = "force-dynamic";

const SCOPE_LABELS: Record<string, string> = {
  "rules:read": "Read this workspace's active rules",
  "session:submit": "Submit approved, redacted sessions for analysis",
  "instructions:read": "Read dashboard instructions from the Agent inbox",
  "rule_result:submit": "Report which rules were followed/violated",
  "export:generate": "Generate rule exports (CLAUDE.md / AGENTS.md / Cursor)",
};

function fmtExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
}

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = await params;
  const claim = await getClaimPublic(claimId);

  const db = await createClient();
  const user = db ? (await db.auth.getUser()).data.user : null;
  const signedIn = Boolean(user);

  return (
    <>
      <Nav />
      <AuthDebugBadge />
      <main className="px-6 pt-32">
        <section className="mx-auto max-w-2xl pb-20">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-wider text-lime">
            Agent connection request
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-[#f5f0e8] sm:text-4xl">
            Approve this agent connection?
          </h1>

          {!claim ? (
            <div className="mt-8 rounded-xl border border-[#222] bg-[#0d0d0d] p-6 text-sm text-muted">
              <p>
                This claim could not be found. It may have been mistyped or removed. Ask the agent to
                request a new claim, then open the new link.
              </p>
              <Link href="/agents" className="mt-4 inline-flex text-lime hover:underline">
                Learn about agent connections →
              </Link>
            </div>
          ) : (
            <>
              {claim.status === "expired" || claim.expired ? (
                <Banner tone="warn">
                  This claim has expired. Ask the agent to request a new one. Claims are valid for
                  30 minutes.
                </Banner>
              ) : claim.status === "approved" ? (
                <Banner tone="ok">This connection was already approved.</Banner>
              ) : claim.status === "rejected" ? (
                <Banner tone="warn">This connection was rejected. No connection exists.</Banner>
              ) : null}

              {/* Request details */}
              <dl className="mt-8 divide-y divide-[#1a1a1a] rounded-xl border border-[#222] bg-[#0d0d0d]">
                <Row label="Repository / workspace" value={claim.repo_hint} mono />
                <Row label="Agent kind" value={agentLabel(normalizeAgentKind(claim.agent_kind))} />
                <Row
                  label="Expires"
                  value={fmtExpiry(claim.expires_at)}
                  mono
                />
                <div className="px-5 py-4">
                  <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">
                    Requested capabilities
                  </dt>
                  <dd className="mt-2">
                    {claim.capabilities.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {claim.capabilities.map((c) => (
                          <span
                            key={c}
                            className="rounded-md border border-[#2a2a2a] bg-[#141414] px-2 py-1 font-mono text-[11px] text-[#d8d2c8]"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted">None declared.</span>
                    )}
                  </dd>
                </div>
                <div className="px-5 py-4">
                  <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">
                    Requested scopes
                  </dt>
                  <dd className="mt-2 space-y-1.5">
                    {claim.requested_scopes.map((s) => (
                      <div key={s} className="flex items-start gap-2 text-sm text-[#d8d2c8]">
                        <span aria-hidden className="mt-0.5 text-lime">
                          ✓
                        </span>
                        <span>
                          <span className="font-mono text-[12px] text-muted">{s}</span>
                          {SCOPE_LABELS[s] ? <span className="ml-2">{SCOPE_LABELS[s]}</span> : null}
                        </span>
                      </div>
                    ))}
                  </dd>
                </div>
              </dl>

              {/* Warning */}
              <div className="mt-6 rounded-xl border border-[#3a2f12] bg-[#15110a] p-4 text-sm leading-relaxed text-[#e8d9b0]">
                ⚠ Approve only if you started this from your own coding agent. Approval lets this
                agent read your workspace rules and submit sessions you approve. It cannot delete
                your workspace, access billing, or read other people&apos;s sessions.
              </div>

              {/* Actions */}
              {claim.status === "pending" && !claim.expired ? (
                <div className="mt-8">
                  <ClaimActions
                    claimId={claim.claim_id}
                    signedIn={signedIn}
                    returnTo={`/claim/${claim.claim_id}`}
                  />
                </div>
              ) : null}

              <p className="mt-8 text-xs leading-relaxed text-muted">
                Human-owned, agent-operated. The claim URL approves the connection. It does not
                create rules. M9R creates workspace rules only from observed session evidence.
              </p>
            </>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`text-right text-sm text-[#f5f0e8] ${mono ? "font-mono text-[13px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "ok"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-lime/30 bg-lime/5 text-[#e8e2d8]"
      : "border-[#3a2f12] bg-[#15110a] text-[#e8d9b0]";
  return <div className={`mt-6 rounded-xl border p-4 text-sm leading-relaxed ${cls}`}>{children}</div>;
}
