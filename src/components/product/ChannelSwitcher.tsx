"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Hash, Lock, Plus, Check } from "lucide-react";
import { channelDisplayName, channelGroupForConversation } from "@/lib/workspace-channel-groups";
import { channelHref } from "@/lib/run-navigation";
import type { ConnectedAgentNavItem } from "@/lib/agent-status-summary";
import { Button, AgentMark } from "@/components/product/WorkspaceUI";

interface SwitcherConversation {
  id: string;
  topic: string;
  channel_slug: string | null;
  channel_kind: "channel" | "dm";
  description: string | null;
  is_private: boolean;
  unread_count: number;
}

interface WorkspaceMemberOption {
  userId: string;
  email: string | null;
  role: string;
}

/**
 * Side-nav channel list + create-channel dialog. Lives in the primary nav
 * (ProductShell), next to the agent picker -- not anchored to the feed
 * header, per explicit correction: switching/creating channels is workspace
 * navigation, not a feed-surface control. Replaces the old always-on
 * pre-made channel list (removed for flooding every workspace with channels
 * nobody asked for) with a real creation flow: a required purpose, an
 * explicit human picker (restricted to actual workspace members), and an
 * explicit agent picker.
 */
export default function SidebarChannelList({
  chatActive,
  agents,
}: {
  chatActive: boolean;
  agents: ConnectedAgentNavItem[];
}) {
  const [conversations, setConversations] = useState<SwitcherConversation[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("conversation");
  const router = useRouter();

  async function refresh() {
    try {
      const res = await fetch("/api/dashboard/conversations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations?: SwitcherConversation[] };
      setConversations(data.conversations ?? []);
    } catch {
      /* nav list degrades to empty rather than throwing -- the feed itself
         still polls and surfaces a real error if the workspace is down. */
    }
  }

  useEffect(() => {
    // The async refresh synchronizes the navigation list with the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, []);

  const channels = conversations.filter((c) => c.channel_kind === "channel");

  return (
    <div className={`wf-channel-nav ${chatActive ? "" : "opacity-70"}`.trim()} aria-label="Channels">
      <div className="wf-micro mb-1 mt-1 text-[color:var(--ol-text-faint)]">Channels</div>
      <ul className="wf-channel-nav-list">
        {channels.map((channel) => {
          const isCore = channelGroupForConversation({ channelSlug: channel.channel_slug, channelKind: channel.channel_kind, topic: channel.topic }) === "core";
          const active = channel.id === selectedId;
          return (
            <li key={channel.id} className="wf-channel-nav-row">
              <Link href={channelHref(channel.id)} className="wf-channel-nav-item" aria-current={active ? "true" : undefined}>
                {channel.is_private ? <Lock size={12} aria-hidden /> : <Hash size={12} aria-hidden />}
                <span className="truncate">{channelDisplayName(channel)}</span>
                {channel.unread_count > 0 && <b className="wf-channel-nav-unread">{channel.unread_count > 99 ? "99+" : channel.unread_count}</b>}
              </Link>
              {!isCore && (
                <LeaveChannelButton
                  conversationId={channel.id}
                  onLeft={() => {
                    void refresh();
                    if (active) router.push("/dashboard/agents");
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className="wf-channel-nav-new" onClick={() => setShowCreate(true)}>
        <Plus size={13} aria-hidden /> New channel
      </button>

      {showCreate && (
        <div className="ol-dialog-overlay" role="dialog" aria-modal="true" aria-label="New channel" onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}>
          <div className="ol-dialog" style={{ maxWidth: "26rem" }}>
            <h2 className="ol-dialog__title">New channel</h2>
            <NewChannelForm
              agents={agents}
              onCancel={() => setShowCreate(false)}
              onCreated={async (conversationId) => {
                setShowCreate(false);
                await refresh();
                router.push(channelHref(conversationId));
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function LeaveChannelButton({ conversationId, onLeft }: { conversationId: string; onLeft: () => void }) {
  const [busy, setBusy] = useState(false);
  async function leave() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/dashboard/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "leave" }),
      });
      if (res.ok) onLeft();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="wf-channel-nav-leave" disabled={busy} onClick={() => void leave()} aria-label="Leave channel">
      {busy ? "…" : "Leave"}
    </button>
  );
}

function NewChannelForm({
  agents,
  onCancel,
  onCreated,
}: {
  agents: ConnectedAgentNavItem[];
  onCancel: () => void;
  onCreated: (conversationId: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [members, setMembers] = useState<WorkspaceMemberOption[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [selectedHumanIds, setSelectedHumanIds] = useState<Set<string>>(new Set());
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedAgents = agents.filter((agent) => agent.connectionId && agent.connected);

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/members")
      .then((res) => (res.ok ? res.json() : { members: [] }))
      .then((body: { members?: Array<{ userId: string; email: string | null; role: string }> }) => {
        if (!active) return;
        const rows = body.members ?? [];
        setMembers(rows);
        // Default: everyone on the workspace + every connected agent pre-checked,
        // matching today's implicit "everyone can see it" behavior -- the human
        // narrows it down from here, rather than starting from an empty,
        // confusing "nobody can see this channel" state.
        setSelectedHumanIds(new Set(rows.map((row) => row.userId)));
      })
      .catch(() => {})
      .finally(() => { if (active) setLoadingMembers(false); });
    return () => { active = false; };
  }, []);

  // Only seed once on mount -- re-running this on every `agents` update would
  // silently re-check an agent a human just unchecked.

  function toggleHuman(userId: string) {
    setSelectedHumanIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }
  function toggleAgent(connectionId: string) {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(connectionId)) next.delete(connectionId); else next.add(connectionId);
      return next;
    });
  }

  async function create() {
    if (creating) return;
    if (!name.trim()) { setError("Channel name is required."); return; }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: purpose,
          isPrivate,
          participantConnectionIds: [...selectedAgentIds],
          humanUserIds: [...selectedHumanIds],
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { conversation?: { id: string }; error?: string };
      if (!res.ok || !json.conversation) {
        setError(json.error || "Could not create the channel.");
        return;
      }
      await onCreated(json.conversation.id);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="wf-channel-switcher-form">
      <label className="wf-channel-switcher-label">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. billing-migration" className="product-input" maxLength={80} />
      </label>
      <label className="wf-channel-switcher-label">
        Purpose <span className="wf-channel-switcher-optional">(optional)</span>
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What is this channel for?" className="product-textarea" rows={2} maxLength={240} />
      </label>

      <label className="wf-channel-switcher-checkbox">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="wf-channel-switcher-check" />
        Private -- only selected humans and agents can see it
      </label>

      <div className="wf-channel-switcher-label">
        <span>Who can join</span>
        {loadingMembers ? (
          <p className="text-[11px] text-[color:var(--ol-text-muted)]">Loading…</p>
        ) : (
          <ul className="wf-channel-switcher-picker">
            {members.map((member) => {
              const checked = selectedHumanIds.has(member.userId);
              const label = member.email ?? member.userId;
              return (
                <li key={member.userId}>
                  <button type="button" className="wf-channel-switcher-picker-row" data-checked={checked} onClick={() => toggleHuman(member.userId)}>
                    <span className="wf-channel-switcher-avatar" aria-hidden>{label.charAt(0).toUpperCase()}</span>
                    <span className="truncate">{label}</span>
                    <span className="wf-channel-switcher-picker-check" aria-hidden>{checked && <Check size={13} strokeWidth={3} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="wf-channel-switcher-label">
        <span>Which agents can be mentioned and act here</span>
        {connectedAgents.length === 0 ? (
          <p className="text-[11px] text-[color:var(--ol-text-muted)]">No agents are currently connected.</p>
        ) : (
          <ul className="wf-channel-switcher-picker">
            {connectedAgents.map((agent) => {
              const checked = selectedAgentIds.has(agent.connectionId);
              return (
                <li key={agent.connectionId}>
                  <button type="button" className="wf-channel-switcher-picker-row" data-checked={checked} onClick={() => toggleAgent(agent.connectionId)}>
                    <AgentMark agentKey={agent.agentKind} size={20} />
                    <span className="truncate">{agent.label}</span>
                    <span className="wf-channel-switcher-picker-check" aria-hidden>{checked && <Check size={13} strokeWidth={3} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && <p className="wf-channel-switcher-error" role="alert">{error}</p>}

      <div className="wf-channel-switcher-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="button" variant="primary" disabled={creating} onClick={() => void create()}>
          {creating ? "Creating…" : "Create channel"}
        </Button>
      </div>
    </div>
  );
}
