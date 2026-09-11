"use client";

import { useEffect, useState } from "react";

interface ResidentActivity {
  id: string;
  provider: string;
  lease_expires_at: string | null;
  revoked_at: string | null;
}

interface ResidentAuthorization {
  id: string;
  resident_instance_id: string;
  repository_binding_id: string;
  revoked_at: string | null;
}

export default function ResidentAuthorizationPanel({
  residentActivity,
  residentAuthorizations,
  defaultBindingByProvider = {},
}: {
  residentActivity: ResidentActivity[];
  residentAuthorizations: ResidentAuthorization[];
  /** Each connected agent's own repo hint, keyed by provider — the real
      binding a resident should authorize against, so the operator never has
      to type one by hand. Falls back to a prior authorization's binding, then
      to empty (only when neither source knows the repo yet). */
  defaultBindingByProvider?: Record<string, string | null>;
}) {
  const [renderedAt, setRenderedAt] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setRenderedAt(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);
  const liveResidents = residentActivity.filter((resident) => !resident.revoked_at && Date.parse(resident.lease_expires_at ?? "") > renderedAt);
  const activeAuthorizations = residentAuthorizations.filter((authorization) => !authorization.revoked_at);
  const authorizedResidentIds = new Set(activeAuthorizations.map((authorization) => authorization.resident_instance_id));
  const firstUnauthorizedProvider = liveResidents.find((resident) => !authorizedResidentIds.has(resident.id))?.provider;
  const [bindingId, setBindingId] = useState(
    () => residentAuthorizations.find((authorization) => !authorization.revoked_at)?.repository_binding_id
      ?? (firstUnauthorizedProvider ? defaultBindingByProvider[firstUnauthorizedProvider] : null)
      ?? "",
  );
  const [authorizationBusy, setAuthorizationBusy] = useState<string | null>(null);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);

  async function authorizeResident(residentId: string) {
    setAuthorizationBusy(residentId);
    setAuthorizationError(null);
    try {
      const response = await fetch("/api/residents/authorizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        // 60k, not 10k: a bounded assignment's fixed overhead (system prompt,
        // loaded skills/MCP context) alone commonly runs ~20k tokens before
        // any real work happens, so 10k rejected every real dispatch as
        // over-budget regardless of task size. This still bounds spend --
        // it isn't unlimited -- it's just sized to the provider's real floor.
        residentInstanceId: residentId, repositoryBindingId: bindingId, capabilities: ["review"], approvalPolicy: "human_before_start",
        maxDurationMs: 600_000, maxEstimatedTokens: 60_000, maxDelegationDepth: 1,
      }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? "Authorization failed."); }
      window.location.reload();
    } catch (error) { setAuthorizationError(error instanceof Error ? error.message : "Authorization failed."); }
    finally { setAuthorizationBusy(null); }
  }

  async function revokeAuthorization(authorizationId: string) {
    setAuthorizationBusy(authorizationId);
    setAuthorizationError(null);
    try {
      const response = await fetch(`/api/residents/authorizations/${encodeURIComponent(authorizationId)}`, { method: "DELETE" });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? "Revocation failed."); }
      window.location.reload();
    } catch (error) { setAuthorizationError(error instanceof Error ? error.message : "Revocation failed."); }
    finally { setAuthorizationBusy(null); }
  }

  if (liveResidents.length === 0 && activeAuthorizations.length === 0) return null;

  const unauthorizedResidents = liveResidents.filter((resident) => !authorizedResidentIds.has(resident.id));
  const providerName = (provider: string) => provider === "claude-code" ? "Claude" : provider === "grok-build" ? "Grok Build" : provider.charAt(0).toUpperCase() + provider.slice(1);

  return (
    <section className="rounded-t-[10px] border-b border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-1)] px-4 py-3" aria-label="Resident authorizations">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--ol-text-secondary)]">Resident access</span>
        {liveResidents.map((resident) => {
          const authorized = authorizedResidentIds.has(resident.id);
          return (
            <span key={resident.id} className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--ol-text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--ol-ok)]" aria-hidden />
              {providerName(resident.provider)} · Online · {authorized ? "Authorized" : "Needs authorization"}
            </span>
          );
        })}

        {unauthorizedResidents.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Authorization required">
            <label htmlFor="resident-binding-id" className="sr-only">Repository binding</label>
            {activeAuthorizations.length > 0 && <span className="sr-only">Previous authorization binding for this provider</span>}
            <input id="resident-binding-id" aria-label="Repository binding" value={bindingId} onChange={(event) => setBindingId(event.target.value)} minLength={8} maxLength={100} className="ol-mono w-52 rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] px-2.5 py-1.5 text-[10px] text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent)]" />
            {unauthorizedResidents.map((resident) => (
              <button key={resident.id} type="button" disabled={authorizationBusy !== null || bindingId.trim().length < 8} onClick={() => void authorizeResident(resident.id)} className="rounded-md bg-[color:var(--ol-accent)] px-3 py-1.5 text-[11px] font-bold text-white shadow-[0_0_14px_color-mix(in_srgb,var(--ol-accent)_30%,transparent)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                {authorizationBusy === resident.id ? "Authorizing…" : `Authorize ${providerName(resident.provider)} for review`}
              </button>
            ))}
          </div>
        )}

        {activeAuthorizations.length > 0 && (
          <div className="ml-auto flex items-center gap-3">
            {activeAuthorizations.map((authorization) => {
              // Multiple stale/active authorizations render as identical
              // unlabeled buttons otherwise -- name the provider each one
              // actually targets so they're distinguishable, not duplicates.
              const owningResident = residentActivity.find((resident) => resident.id === authorization.resident_instance_id);
              const label = owningResident ? providerName(owningResident.provider) : authorization.resident_instance_id.slice(0, 8);
              const isLive = liveResidents.some((resident) => resident.id === authorization.resident_instance_id);
              return (
                <button key={authorization.id} type="button" disabled={authorizationBusy !== null} onClick={() => void revokeAuthorization(authorization.id)} className="text-[10px] text-[color:var(--ol-text-faint)] underline underline-offset-4 transition hover:text-[color:var(--ol-danger)] disabled:opacity-50" aria-label={`${isLive ? "Revoke active" : "Remove stale"} authorization for ${label}`}>
                  {authorizationBusy === authorization.id ? "Revoking…" : `${isLive ? "Revoke active" : "Remove stale"}: ${label}`}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {authorizationError && <p role="alert" className="mt-2 text-[10px] text-[color:var(--ol-danger)]">{authorizationError}</p>}
    </section>
  );
}
