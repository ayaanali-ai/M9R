"use client";

/**
 * SettingsView — the full, built-out settings surface.
 * ----------------------------------------------------------------------------
 * Four sections, Linear-style: Account, Subscription, Data & privacy, and
 * Preferences — plus a danger zone. Everything that can be real is real
 * (copy id, export download, clear data, local preferences); sections that
 * depend on systems we haven't shipped say so honestly with a roadmap chip,
 * rather than faking buttons.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ResidentAuthorizationPanel from "@/components/product/ResidentAuthorizationPanel";
import ProductConfirmDialog from "@/components/product/ProductConfirmDialog";
import { AgentMark, Button } from "@/components/product/WorkspaceUI";
import { relAt } from "@/components/product/agent-workspace/shared";
import { providerLabel } from "@/lib/provider-adapter-config";

// Connected agents sits right after Account -- this is the product's whole
// subject, and revoke/disconnect (the single most consequential control in
// Settings) lives here. It used to render 4th, below Subscription and Agent
// access, which buried it under things a user touches far less often.
const SECTIONS = [
  ["account", "Account"],
  ["workspace-name", "Workspace name"],
  ["identity", "Workspace identity"],
  ["team", "Team"],
  ["connections", "Connected agents"],
  ["subscription", "Subscription"],
  ["access", "Agent access"],
  ["git", "Git events"],
  ["data", "Data & privacy"],
] as const;

export default function SettingsView({ email, userId, username }: { email: string; userId: string; username: string | null }) {
  const initial = (username ?? email).trim().charAt(0).toUpperCase() || "O";

  return (
    <div className="settings-layout">
      {/* Sticky in-page section nav (desktop). */}
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="settings-nav-link">
            {label}
          </a>
        ))}
      </nav>

      <div className="min-w-0 space-y-4">
        <AccountSection email={email} userId={userId} username={username} initial={initial} />
        <WorkspaceNameSection />
        <WorkspaceIdentitySection />
        <TeamSection viewerUserId={userId} />
        <ConnectedAgentsSection />
        <SubscriptionSection />
        <AgentAccessSection />
        <GitEventsSection />
        <DataPrivacySection />
      </div>
    </div>
  );
}

/* API tokens (#15) parked for later -- see user-api-token-service.ts and
   api/mcp/memory/route.ts, both left in place, unwired from the UI. */

/* -------------------------------------------------------------------------- */
/* Agent access (resident authorization)                                      */
/* -------------------------------------------------------------------------- */

function AgentAccessSection() {
  const [residents, setResidents] = useState<Parameters<typeof ResidentAuthorizationPanel>[0]["residentActivity"]>([]);
  const [authorizations, setAuthorizations] = useState<Parameters<typeof ResidentAuthorizationPanel>[0]["residentAuthorizations"]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/residents/authorizations")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { residents?: typeof residents; authorizations?: typeof authorizations } | null) => {
        if (!active || !body) return;
        setResidents(body.residents ?? []);
        setAuthorizations(body.authorizations ?? []);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <Section
      id="access"
      title="Agent access"
      description="Authorize a standing local agent process (npx m9r-cli terminal runtime) to spawn real sessions automatically when @mentioned. This is separate from the one-time connection every agent already has."
    >
      {loading ? (
        <p className="p-4 text-[12px] text-[color:var(--ol-text-muted)]">Loading…</p>
      ) : residents.length === 0 ? (
        <p className="p-4 text-[12px] text-[color:var(--ol-text-muted)]">
          No standing agent process has registered yet. This only appears once you run{" "}
          <code className="ol-mono">npx m9r-cli terminal runtime</code>. The plain CLI connection doesn&apos;t need
          anything here.
        </p>
      ) : (
        <ResidentAuthorizationPanel residentActivity={residents} residentAuthorizations={authorizations} defaultBindingByProvider={{}} />
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Workspace name — the workspace's display name (projects.name). Separate   */
/* from Workspace identity below: that's a free-text mission agents read,    */
/* this is just what the workspace is called. Owner-only, enforced by        */
/* projects' own UPDATE RLS policy.                                          */
/* -------------------------------------------------------------------------- */

function WorkspaceNameSection() {
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/rename")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { name?: string } | null) => {
        if (!active) return;
        const current = body?.name ?? "";
        setName(current);
        setSaved(current);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/rename", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNotice(json.error || "Could not save.");
        return;
      }
      setSaved(name.trim());
      setNotice("Saved.");
    } catch {
      setNotice("Could not reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section id="workspace-name" title="Workspace name" description="What this workspace is called.">
      {loading ? (
        <p className="text-[12px] text-[color:var(--ol-text-muted)]">Loading…</p>
      ) : (
        <>
          <input
            type="text"
            className="product-input w-full max-w-sm"
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Workspace name"
          />
          <div className="mt-2.5 flex items-center gap-2.5">
            <Button type="button" size="sm" variant="secondary" disabled={saving || !name.trim() || name.trim() === (saved ?? "")} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {notice && <span className="text-[12px] text-[color:var(--ol-text-muted)]" role="status">{notice}</span>}
          </div>
        </>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Workspace identity — the one durable "why does this workspace exist"      */
/* record every connected agent reads before doing anything (see brief.ts).  */
/* Human-set only: agents can never write this, unlike Memory's rules and    */
/* findings which agents propose and a human only reviews.                   */
/* -------------------------------------------------------------------------- */

function WorkspaceIdentitySection() {
  const [mission, setMission] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/identity")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { identity?: { mission: string } | null } | null) => {
        if (!active) return;
        const current = body?.identity?.mission ?? "";
        setMission(current);
        setSaved(body?.identity ? current : null);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/identity", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mission }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNotice(json.error || "Could not save.");
        return;
      }
      setSaved(mission);
      setNotice("Saved. Every connected agent reads this before doing anything.");
    } catch {
      setNotice("Could not reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      id="identity"
      title="Workspace identity"
      description="What this workspace is for, in your own words. Every connected agent reads this before starting work -- agents can never write it themselves."
    >
      {loading ? (
        <p className="text-[12px] text-[color:var(--ol-text-muted)]">Loading…</p>
      ) : (
        <>
          <textarea
            className="product-textarea w-full"
            rows={4}
            maxLength={2000}
            value={mission}
            onChange={(event) => setMission(event.target.value)}
            placeholder="e.g. Ship the billing migration without downtime. Prefer small PRs. Never touch the legacy auth middleware."
          />
          <div className="mt-2.5 flex items-center gap-2.5">
            <Button type="button" size="sm" variant="secondary" disabled={saving || mission.trim() === (saved ?? "")} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {notice && <span className="text-[12px] text-[color:var(--ol-text-muted)]" role="status">{notice}</span>}
          </div>
        </>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Team — workspace membership and roles (phase 1: see                       */
/* workspace-membership-service.ts for what this does and doesn't cover      */
/* yet). Owner/admin can invite, promote, demote, and remove; any non-owner  */
/* member can leave. Never fabricated as "everyone already collaborates" --  */
/* the roster only shows real workspace_members rows.                       */
/* -------------------------------------------------------------------------- */

interface TeamMemberRow {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member";
  email: string | null;
  createdAt: string;
}

interface TeamInviteRow {
  id: string;
  email: string;
  role: "admin" | "member";
  createdAt: string;
  expiresAt: string;
}

function TeamSection({ viewerUserId }: { viewerUserId: string }) {
  const router = useRouter();
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [invites, setInvites] = useState<TeamInviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    Promise.all([
      fetch("/api/workspace/members").then((res) => (res.ok ? res.json() : { members: [] })),
      fetch("/api/workspace/invites").then((res) => (res.ok ? res.json() : { invites: [] })),
    ])
      .then(([membersBody, invitesBody]: [{ members?: TeamMemberRow[] }, { invites?: TeamInviteRow[] }]) => {
        setMembers(membersBody.members ?? []);
        setInvites(invitesBody.invites ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const timer = window.setTimeout(reload, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const viewer = members.find((m) => m.userId === viewerUserId);
  const canManage = viewer?.role === "owner" || viewer?.role === "admin";
  const canLeave = viewer && viewer.role !== "owner";

  async function sendInvite() {
    setInviting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNotice(json.error || "Could not send invite.");
        return;
      }
      setInviteEmail("");
      setNotice(`Invited ${inviteEmail}.`);
      reload();
    } catch {
      setNotice("Could not reach the server. Try again.");
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(userId: string, role: "admin" | "member") {
    setBusyUserId(userId);
    setNotice(null);
    try {
      const res = await fetch(`/api/workspace/members/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setNotice(json.error || "Could not change role."); return; }
      reload();
    } finally {
      setBusyUserId(null);
    }
  }

  async function removeMember(userId: string) {
    setBusyUserId(userId);
    setNotice(null);
    try {
      const res = await fetch(`/api/workspace/members/${userId}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setNotice(json.error || "Could not remove that member."); return; }
      reload();
    } finally {
      setBusyUserId(null);
    }
  }

  async function revokeInvite(inviteId: string) {
    setBusyInviteId(inviteId);
    try {
      await fetch(`/api/workspace/invites/${inviteId}`, { method: "DELETE" });
      reload();
    } finally {
      setBusyInviteId(null);
    }
  }

  async function leaveWorkspace() {
    setLeaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/leave", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setNotice(json.error || "Could not leave the workspace."); return; }
      router.refresh();
    } finally {
      setLeaving(false);
    }
  }

  return (
    <Section id="team" title="Team" description="Who's in this workspace, and what they can do.">
      {loading ? (
        <p className="text-[12px] text-[color:var(--ol-text-muted)]">Loading…</p>
      ) : (
        <>
          <ul className="divide-y divide-[color:var(--ol-border-subtle)]">
            {members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-[color:var(--ol-text-primary)]">
                    {member.email ?? member.userId}
                    {member.userId === viewerUserId && <span className="ml-1.5 text-[11px] text-[color:var(--ol-text-muted)]">(you)</span>}
                  </div>
                  <div className="text-[11px] text-[color:var(--ol-text-muted)] capitalize">{member.role}</div>
                </div>
                {canManage && member.role !== "owner" && member.userId !== viewerUserId && (
                  <div className="flex items-center gap-1.5">
                    {member.role === "member" ? (
                      <Button type="button" size="sm" variant="secondary" disabled={busyUserId === member.userId} onClick={() => void changeRole(member.userId, "admin")}>
                        Make admin
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" disabled={busyUserId === member.userId} onClick={() => void changeRole(member.userId, "member")}>
                        Remove admin
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="danger" disabled={busyUserId === member.userId} onClick={() => void removeMember(member.userId)}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {invites.length > 0 && (
            <>
              <div className="my-4 border-t border-[color:var(--ol-border-subtle)]" />
              <p className="bs-micro mb-2">Pending invites</p>
              <ul className="divide-y divide-[color:var(--ol-border-subtle)]">
                {invites.map((invite) => (
                  <li key={invite.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-[color:var(--ol-text-primary)]">{invite.email}</div>
                      <div className="text-[11px] text-[color:var(--ol-text-muted)] capitalize">{invite.role} · expires {new Date(invite.expiresAt).toLocaleDateString()}</div>
                    </div>
                    {canManage && (
                      <Button type="button" size="sm" variant="ghost" disabled={busyInviteId === invite.id} onClick={() => void revokeInvite(invite.id)}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {canManage && (
            <>
              <div className="my-4 border-t border-[color:var(--ol-border-subtle)]" />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="product-input min-w-0 flex-1"
                />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "member")} className="product-input w-32">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <Button type="button" size="sm" variant="secondary" disabled={inviting || !inviteEmail.trim()} onClick={() => void sendInvite()}>
                  {inviting ? "Inviting…" : "Invite"}
                </Button>
              </div>
            </>
          )}

          {canLeave && (
            <>
              <div className="my-4 border-t border-[color:var(--ol-border-subtle)]" />
              <Button type="button" size="sm" variant="danger" disabled={leaving} onClick={() => void leaveWorkspace()}>
                {leaving ? "Leaving…" : "Leave this workspace"}
              </Button>
            </>
          )}

          {notice && <p className="mt-3 text-[12px] text-[color:var(--ol-text-muted)]" role="status">{notice}</p>}
        </>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Connected agents — revoke access. The one UI path for this now; it used   */
/* to be a per-agent button on the Watchfloor's control strip, moved here    */
/* since it's a rare, high-stakes account action, not a daily-driver one.    */
/* -------------------------------------------------------------------------- */

interface ConnectedAgentRow {
  connectionId: string;
  agentKind: string;
  repoHint: string | null;
  lastSeenAt: string | null;
}

function ConnectedAgentsSection() {
  const router = useRouter();
  const [connections, setConnections] = useState<ConnectedAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(0);
  const [disconnectTarget, setDisconnectTarget] = useState<ConnectedAgentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setClock(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/dashboard/connections")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { connections?: ConnectedAgentRow[] } | null) => {
        if (!active || !body) return;
        setConnections(body.connections ?? []);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function disconnect() {
    if (!disconnectTarget || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/connections/${disconnectTarget.connectionId}/disconnect`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error || "Could not disconnect this agent.");
      }
      setConnections((current) => current.filter((row) => row.connectionId !== disconnectTarget.connectionId));
      setDisconnectTarget(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect this agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="connections"
      title="Connected agents"
      description="Revoke a coding agent's access. Historical runs, evidence, Run Passports, and review decisions are preserved. Only its ability to connect again is revoked."
    >
      {loading ? (
        <p className="p-4 text-[12px] text-[color:var(--ol-text-muted)]">Loading…</p>
      ) : connections.length === 0 ? (
        <p className="p-4 text-[12px] text-[color:var(--ol-text-muted)]">No agents are currently connected.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--ol-border-subtle)]">
          {connections.map((row) => (
            <li key={row.connectionId} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <AgentMark agentKey={row.agentKind} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-[color:var(--ol-text-primary)]">{providerLabel(row.agentKind)}</div>
                <div className="ol-mono text-[11px] text-[color:var(--ol-text-muted)]">
                  {row.repoHint || "workspace"} · seen {relAt(row.lastSeenAt, clock)}
                </div>
              </div>
              {/* This was `variant="ghost"` -- quieter than the "Copy ID"
                  button that used to sit next to it, despite being the most
                  consequential control on this page. WorkspaceUI's danger
                  variant is normally reserved for a <DestructiveZone/>, but
                  that's a single-prominent-action pattern; a per-row list
                  action doesn't fit a bordered zone box, so this uses the
                  variant directly. */}
              <Button type="button" variant="danger" size="sm" onClick={() => setDisconnectTarget(row)}>
                Disconnect / revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 text-[12px] text-[color:var(--ol-danger)]">{error}</p>}
      <ProductConfirmDialog
        open={disconnectTarget !== null}
        title={`Disconnect ${disconnectTarget?.agentKind ?? "this agent"}?`}
        description="Existing local access for this agent will be revoked. Historical runs, evidence, Run Passports, and review decisions will be preserved."
        confirmLabel="Disconnect / revoke"
        busy={busy}
        onCancel={() => setDisconnectTarget(null)}
        onConfirm={() => void disconnect()}
      />
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Git events (repo -> channel bindings)                                      */
/* -------------------------------------------------------------------------- */

interface GithubBindingRow {
  id: string;
  repoFullName: string;
  conversationId: string;
  conversationTopic: string;
}

function GitEventsSection() {
  const [bindings, setBindings] = useState<GithubBindingRow[]>([]);
  const [channels, setChannels] = useState<Array<{ id: string; topic: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [repoFullName, setRepoFullName] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    Promise.all([
      fetch("/api/dashboard/github-bindings").then((res) => (res.ok ? res.json() : { bindings: [] })),
      fetch("/api/dashboard/conversations").then((res) => (res.ok ? res.json() : { conversations: [] })),
    ])
      .then(([bindingsBody, conversationsBody]: [{ bindings?: GithubBindingRow[] }, { conversations?: Array<{ id: string; topic: string }> }]) => {
        setBindings(bindingsBody.bindings ?? []);
        setChannels(conversationsBody.conversations ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const timer = window.setTimeout(reload, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function addBinding() {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/dashboard/github-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoFullName, conversationId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(json.error || "Could not bind that repo.");
        return;
      }
      setRepoFullName("");
      setConversationId("");
      reload();
    } finally {
      setSaving(false);
    }
  }

  async function removeBinding(id: string) {
    await fetch(`/api/dashboard/github-bindings?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    reload();
  }

  return (
    <Section
      id="git"
      title="Git events"
      description="Bind a repo the M9R Bridge GitHub App is installed on to a channel. Pushes, PR opens/merges, and reviews post there automatically, including when no agent self-reports a commit."
    >
      {loading ? (
        <p className="p-4 text-[12px] text-[color:var(--ol-text-muted)]">Loading…</p>
      ) : (
        <>
          {bindings.length === 0 ? (
            <p className="text-[12px] text-[color:var(--ol-text-muted)]">No repo is bound to a channel yet.</p>
          ) : (
            <ul className="space-y-2">
              {bindings.map((binding) => (
                <li key={binding.id} className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--ol-border-subtle)] px-3 py-2">
                  <div className="min-w-0">
                    <div className="ol-mono text-[12px] text-[color:var(--ol-text-primary)]">{binding.repoFullName}</div>
                    <div className="text-[11px] text-[color:var(--ol-text-muted)]">→ #{binding.conversationTopic}</div>
                  </div>
                  <button onClick={() => removeBinding(binding.id)} className="ol-btn ol-btn--ghost ol-btn--sm">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
              placeholder="owner/repo"
              className="product-input w-48"
            />
            <select value={conversationId} onChange={(e) => setConversationId(e.target.value)} className="product-input w-48">
              <option value="">Choose a channel…</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.topic}
                </option>
              ))}
            </select>
            <button onClick={addBinding} disabled={saving || !repoFullName || !conversationId} className="ol-btn ol-btn--secondary">
              {saving ? "Binding…" : "Bind repo"}
            </button>
          </div>
          {notice && <p className="mt-2 text-[12px] text-[color:var(--ol-text-secondary)]" role="status">{notice}</p>}
        </>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Account                                                                    */
/* -------------------------------------------------------------------------- */

function AccountSection({ email, userId, username, initial }: { email: string; userId: string; username: string | null; initial: string }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [ensuring, setEnsuring] = useState(false);
  const [ensureNotice, setEnsureNotice] = useState<string | null>(null);
  const [usernameValue, setUsernameValue] = useState(username ?? "");
  const [savedUsername, setSavedUsername] = useState(username);
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [usernameNotice, setUsernameNotice] = useState<string | null>(null);

  async function saveUsername() {
    setUsernameBusy(true);
    setUsernameNotice(null);
    try {
      const response = await fetch("/api/account/username", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: usernameValue }),
      });
      const body = await response.json().catch(() => ({})) as { username?: string; error?: string; warning?: string };
      if (!response.ok || !body.username) {
        setUsernameNotice(body.error ?? "Could not update username.");
        return;
      }
      setUsernameValue(body.username);
      setSavedUsername(body.username);
      setUsernameNotice(body.warning ?? `Username updated to @${body.username}.`);
      router.refresh();
    } catch {
      setUsernameNotice("Could not reach the account service. Try again.");
    } finally {
      setUsernameBusy(false);
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  }

  // One-click repair: guarantees a "Default workspace" exists for this account.
  // Useful for users created before the signup trigger reliably provisioned one.
  async function ensureDefaultWorkspace() {
    setEnsuring(true);
    setEnsureNotice(null);
    try {
      const res = await fetch("/api/projects/ensure-default", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        project?: { name: string };
      };
      if (!res.ok || !json.ok) {
        setEnsureNotice(json.error || "Couldn't ensure a workspace.");
        return;
      }
      setEnsureNotice(`Workspace ready: ${json.project?.name ?? "Default workspace"}.`);
      router.refresh();
    } finally {
      setEnsuring(false);
    }
  }

  return (
    <Section id="account" title="Account" description="Who you're signed in as.">
      <div className="flex items-center gap-3.5">
        <span className="settings-avatar">{initial}</span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-[color:var(--ol-text-primary)]">{savedUsername ? `@${savedUsername}` : "Set username"}</div>
          <div className="text-[12px] text-[color:var(--ol-text-muted)]">Personal account</div>
        </div>
      </div>

      <dl className="mt-5 space-y-3.5 border-t border-[color:var(--ol-border-subtle)] pt-5 text-[13px]">
        <Row label="Email">
          <span className="text-[color:var(--ol-text-secondary)]">{email}</span>
        </Row>
        <Row label="Username">
          <div className="flex max-w-md flex-wrap items-center gap-2">
            <input
              className="product-input min-w-0 flex-1"
              value={usernameValue}
              onChange={(event) => setUsernameValue(event.target.value.toLowerCase())}
              minLength={3}
              maxLength={30}
              pattern="[A-Za-z0-9][A-Za-z0-9_]{2,29}"
              autoComplete="username"
              aria-label="Username"
              placeholder="your_username"
            />
            <button type="button" onClick={() => void saveUsername()} disabled={usernameBusy || usernameValue.trim() === savedUsername} className="ol-btn ol-btn--secondary ol-btn--sm">
              {usernameBusy ? "Saving…" : savedUsername ? "Change username" : "Set username"}
            </button>
            {usernameNotice && <span className="basis-full text-[12px] text-[color:var(--ol-text-muted)]" role="status">{usernameNotice}</span>}
          </div>
        </Row>
        <Row label="User ID">
          <div className="flex items-center gap-2">
            <span className="ol-mono break-all text-[12px] text-[color:var(--ol-text-muted)]">{userId}</span>
            <button onClick={copyId} className="ol-btn ol-btn--secondary ol-btn--sm">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </Row>
      </dl>

      {/* Workspace repair — idempotent guarantee that a Default workspace exists. */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--ol-border-subtle)] pt-5">
        <div>
          <div className="text-[13px] text-[color:var(--ol-text-primary)]">Default workspace</div>
          <p className="mt-0.5 text-[12px] text-[color:var(--ol-text-muted)]">
            Ensure your account has a workspace for traces and rules. Safe to run anytime.
          </p>
        </div>
        <button onClick={ensureDefaultWorkspace} disabled={ensuring} className="ol-btn ol-btn--secondary">
          {ensuring ? "Checking…" : "Ensure default workspace"}
        </button>
      </div>
      {ensureNotice && <p className="mt-2.5 text-[12px] text-[color:var(--ol-text-secondary)]">{ensureNotice}</p>}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Subscription / Billing                                                     */
/* -------------------------------------------------------------------------- */

interface BillingStatus {
  plan: "free" | "paid" | "unknown";
  subscription: {
    tier: "monthly" | "annual" | null;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

function SubscriptionSection() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"monthly" | "annual" | "portal" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/billing/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: BillingStatus | null) => { if (active && body) setStatus(body); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    const noticeTimer = new URLSearchParams(window.location.search).get("upgraded") === "1"
      ? window.setTimeout(() => {
        if (active) setNotice("Upgrade received. This can take a few seconds to sync. Refresh if it still says Free.");
      }, 0)
      : null;
    return () => {
      active = false;
      if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    };
  }, []);

  async function startCheckout(interval: "monthly" | "annual") {
    setBusy(interval);
    setNotice(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !body.url) { setNotice(body.error ?? "Could not start checkout."); return; }
      window.location.href = body.url;
    } catch {
      setNotice("Could not reach the billing service. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setNotice(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !body.url) { setNotice(body.error ?? "Could not open billing portal."); return; }
      window.location.href = body.url;
    } catch {
      setNotice("Could not reach the billing service. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const isPaid = status?.plan === "paid";

  return (
    <Section id="subscription" title="Subscription" description="Your plan and billing.">
      <div className="ol-row flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-[color:var(--ol-text-primary)]">
              {loading ? "…" : isPaid ? "Pro" : "Free"}
            </span>
            <span className="ol-lozenge ol-lozenge--ok">Current plan</span>
            {isPaid && status?.subscription?.cancelAtPeriodEnd && (
              <span className="ol-lozenge ol-lozenge--warn">Cancels at period end</span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-[color:var(--ol-text-muted)]">
            {isPaid
              ? `Billed ${status?.subscription?.tier === "annual" ? "annually" : "monthly"}${status?.subscription?.currentPeriodEnd ? ` · renews ${new Date(status.subscription.currentPeriodEnd).toLocaleDateString()}` : ""}.`
              : "Up to 2 agents, 10 active rules, 30-day audit log retention. No card required."}
          </p>
        </div>
        {isPaid ? (
          <button className="ol-btn ol-btn--secondary" disabled={busy === "portal"} onClick={openPortal}>
            {busy === "portal" ? "Opening…" : "Manage billing"}
          </button>
        ) : (
          <div className="flex gap-2">
            <button className="ol-btn ol-btn--secondary" disabled={busy !== null} onClick={() => startCheckout("annual")}>
              {busy === "annual" ? "Redirecting…" : "Upgrade · $11/mo annual"}
            </button>
            <button className="ol-btn ol-btn--primary" disabled={busy !== null} onClick={() => startCheckout("monthly")}>
              {busy === "monthly" ? "Redirecting…" : "Upgrade · $14/mo"}
            </button>
          </div>
        )}
      </div>
      {notice && <p className="mt-3 text-[12px] text-[color:var(--ol-warn)]">{notice}</p>}
      {!isPaid && (
        <p className="mt-3 text-[12px] text-[color:var(--ol-text-muted)]">
          Pro removes every limit above and adds priority support. Manage payment methods, invoices,
          and cancellation from Stripe&apos;s billing portal once you&apos;re subscribed.
        </p>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Data & privacy                                                             */
/* -------------------------------------------------------------------------- */

function DataPrivacySection() {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function exportData() {
    setExporting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) {
        setNotice(res.status === 401 ? "Sign in to export your data." : "Export failed.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `oathlock-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function clearData() {
    setClearing(true);
    setNotice(null);
    try {
      const res = await fetch("/api/account/purge", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; deleted?: { traces: number; rules: number } };
      if (!res.ok || !json.ok) {
        setNotice(json.error || "Couldn't clear data.");
        return;
      }
      setNotice(`Cleared ${json.deleted?.traces ?? 0} traces and ${json.deleted?.rules ?? 0} rules.`);
      setConfirming(false);
      setConfirmText("");
      router.refresh();
    } finally {
      setClearing(false);
    }
  }

  return (
    <Section id="data" title="Data & privacy" description="Your evidence stays scoped to your workspace.">
      {/* Export */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
        <div>
          <div className="text-[13px] text-[color:var(--ol-text-primary)]">Export your data</div>
          <p className="mt-0.5 text-[12px] text-[color:var(--ol-text-muted)]">Download your workspaces, connected agents, runs, evidence, findings, and rules as JSON.</p>
        </div>
        <button onClick={exportData} disabled={exporting} className="ol-btn ol-btn--secondary">
          {exporting ? "Preparing…" : "Export"}
        </button>
      </div>

      <div className="my-4 border-t border-[color:var(--ol-border-subtle)]" />

      {/* Danger zone — the one gated hard-delete lives inside the destructive zone. */}
      <div className="ol-destructive-zone">
        <p className="ol-destructive-zone__label">Danger zone</p>
        <p className="text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
          Clearing data soft-deletes legacy uploaded traces and the legacy rule list in your account.
          Connected agents, run history, evidence, findings, and workspace rules are not affected.
          Those are the tamper-evident record and aren&apos;t erased from here. This can&apos;t be
          undone from the app.
        </p>

        {confirming ? (
          <div className="mt-3">
            <p className="text-[12px] text-[color:var(--ol-text-secondary)]">
              Type <span className="ol-mono text-[color:var(--ol-text-primary)]">DELETE</span> to confirm:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="product-input w-32"
                placeholder="DELETE"
              />
              <button
                onClick={clearData}
                disabled={confirmText !== "DELETE" || clearing}
                className="ol-btn ol-btn--danger"
              >
                {clearing ? "Clearing…" : "Clear all data"}
              </button>
              <button onClick={() => setConfirming(false)} className="ol-btn ol-btn--ghost ol-btn--sm">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="ol-btn ol-btn--danger mt-3">
            Clear all data
          </button>
        )}

        {notice && <p className="mt-2.5 text-[12px] text-[color:var(--ol-text-secondary)]" role="status">{notice}</p>}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared atoms                                                               */
/* -------------------------------------------------------------------------- */

function Section({
  id,
  title,
  description,
  badge,
  children,
}: {
  id: string;
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="ol-panel scroll-mt-24 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="bs-micro">{title}</div>
          <p className="mt-1.5 text-[13px] font-medium text-[color:var(--ol-text-primary)]">{description}</p>
        </div>
        {badge && <span className="ol-lozenge ol-lozenge--muted">{badge}</span>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-[color:var(--ol-border-subtle)] py-2.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[9rem_1fr] sm:items-baseline">
      <dt className="bs-micro">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
