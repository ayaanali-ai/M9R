"use client";

/**
 * Goal Handoff Panel — the visible half of Goal Gateway (see
 * M9R_MASTER_BUILD_PLAN.md and docs/designs/m9r-personal-agent-goal-gateway.md).
 * The backend (durable Goals above Mission, human-authorized, provenance-bound
 * context packets, evidence-backed completion receipts) already existed and
 * ran for real; this is the piece that was missing entirely -- a human-visible
 * record of what got handed off between agents, and what was proven done.
 *
 * Answers the exact thing asked in replies to the open-core announcement:
 * "how do you handle context drift ... across different providers" and
 * "explicit handoff protocols, not merely synchronized chat histories."
 *
 * Deliberately its own file (see task-card.tsx's own comment for why:
 * ConversationPanel.tsx is already the largest file in the repo). Unlike
 * Whispers, this toggle is NOT hidden when empty -- Whispers already had
 * organic usage before its toggle existed, so an always-visible empty tab
 * was pure noise; Goal Gateway is brand new and no agent has been told to
 * use it yet, so hiding an empty state here would make the feature
 * undiscoverable rather than uncluttering anything.
 */

import { useCallback, useEffect, useState } from "react";

export type GoalStatus =
  | "proposed" | "authorized" | "planning" | "executing" | "waiting"
  | "blocked" | "review" | "completed" | "failed" | "cancelled" | "paused";

export interface GoalHandoffSummary {
  id: string;
  title: string;
  objective: string;
  principalId: string;
  principalKind: string;
  status: GoalStatus;
  currentMissionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GoalHandoffEvent {
  id: string;
  type: string;
  actorKind: string;
  actorId: string;
  occurredAt: string;
}

interface GoalHandoffContextPacket {
  packet: {
    id: string;
    sourceAgentId: string;
    intendedRecipientPrincipalId: string | null;
    purpose: string;
    sensitivity: "public" | "workspace" | "private" | "restricted";
    redactionStatus: "not_required" | "redacted" | "verified";
    createdAt: string;
  };
}

interface GoalHandoffReceipt {
  receipt: {
    receiptId: string;
    status: "achieved" | "failed" | "blocked" | "needs_decision";
    conditions: unknown[];
    evidence: unknown[];
    unresolvedRisks: string[];
    generatedAt: string;
  };
}

interface GoalHandoffRecord {
  goal: GoalHandoffSummary;
  events: GoalHandoffEvent[];
  contextPackets: GoalHandoffContextPacket[];
  receipts: GoalHandoffReceipt[];
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  proposed: "Proposed", authorized: "Authorized", planning: "Planning",
  executing: "In progress", waiting: "Waiting", blocked: "Blocked",
  review: "In review", completed: "Completed", failed: "Failed",
  cancelled: "Cancelled", paused: "Paused",
};

const SENSITIVITY_LABEL: Record<string, string> = {
  public: "Public", workspace: "Workspace", private: "Private", restricted: "Restricted",
};

function timeAgo(iso: string): string {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (deltaSeconds < 60) return "just now";
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function GoalHandoffPanel({ onClose }: { onClose: () => void }) {
  const [goals, setGoals] = useState<GoalHandoffSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/goals", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { goals?: GoalHandoffSummary[] }) => { if (!cancelled) setGoals(data.goals ?? []); })
      .catch(() => { if (!cancelled) setError("Could not load goals."); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="wf-files-rail-header">
        <span>Handoffs</span>
        <button type="button" className="wf-files-rail-collapse" onClick={onClose} aria-label="Collapse handoffs panel">×</button>
      </div>
      <div className="wf-activity-feed scrollbar-thin">
        {error ? (
          <p className="wf-task-card-whispers-empty">{error}</p>
        ) : !goals ? (
          <p className="wf-task-card-whispers-empty">Loading…</p>
        ) : goals.length === 0 ? (
          <p className="wf-task-card-whispers-empty">
            No goals proposed yet. When an agent proposes a durable goal and a
            human authorizes it, the handoff record — what context was passed
            between agents, and what was proven done — shows up here.
          </p>
        ) : (
          <ul className="wf-activity-feed-list">
            {goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} expanded={expandedId === goal.id}
                onToggle={() => setExpandedId((current) => (current === goal.id ? null : goal.id))} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function GoalRow({ goal, expanded, onToggle }: { goal: GoalHandoffSummary; expanded: boolean; onToggle: () => void }) {
  const [record, setRecord] = useState<GoalHandoffRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (record || loading) return;
    setLoading(true);
    setDetailError(null);
    fetch(`/api/dashboard/goals/${encodeURIComponent(goal.id)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: GoalHandoffRecord & { error?: string }) => {
        if (data.error) { setDetailError(data.error); return; }
        setRecord(data);
      })
      .catch(() => setDetailError("Could not load this goal's handoff record."))
      .finally(() => setLoading(false));
  }, [goal.id, record, loading]);

  function handleToggle() {
    onToggle();
    if (!expanded) load();
  }

  return (
    <li className="wf-activity-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <button type="button" onClick={handleToggle} aria-expanded={expanded}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }}>
        <span className={expanded ? "wf-task-card-chevron is-open" : "wf-task-card-chevron"} aria-hidden>›</span>
        <div className="min-w-0 flex-1">
          <div className="truncate">{goal.title}</div>
          <div className="wf-activity-row-meta">
            <span>{goal.principalKind.replace("_", " ")}</span>
            <span>{timeAgo(goal.createdAt)}</span>
          </div>
        </div>
        <span className="wf-activity-row-badge" data-status={
          goal.status === "completed" ? "ready"
            : goal.status === "failed" || goal.status === "blocked" || goal.status === "cancelled" ? "denied"
              : goal.status === "proposed" ? "pending" : "idle"
        }>
          {STATUS_LABEL[goal.status]}
        </span>
      </button>
      {expanded && (
        <div className="wf-task-card-whispers" style={{ marginTop: 8 }}>
          {loading ? (
            <p className="wf-task-card-whispers-empty">Loading…</p>
          ) : detailError ? (
            <p className="wf-task-card-whispers-empty">{detailError}</p>
          ) : record ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ margin: 0, fontSize: 12 }}>{record.goal.objective}</p>

              <div>
                <div className="ol-mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.7, marginBottom: 4 }}>
                  Context handed off ({record.contextPackets.length})
                </div>
                {record.contextPackets.length === 0 ? (
                  <p className="wf-task-card-whispers-empty">No context packets recorded — nothing has been handed off between agents on this goal yet.</p>
                ) : (
                  <ul className="wf-task-card-whispers-list">
                    {record.contextPackets.map((cp) => (
                      <li key={cp.packet.id} className="wf-task-card-whisper">
                        <span className="wf-task-card-whisper-sender">{SENSITIVITY_LABEL[cp.packet.sensitivity]}{cp.packet.redactionStatus === "verified" ? " · redaction verified" : ""}</span>
                        <span className="wf-task-card-whisper-body">{cp.packet.purpose}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="ol-mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.7, marginBottom: 4 }}>
                  Completion receipts ({record.receipts.length})
                </div>
                {record.receipts.length === 0 ? (
                  <p className="wf-task-card-whispers-empty">Nothing marked done yet.</p>
                ) : (
                  <ul className="wf-task-card-whispers-list">
                    {record.receipts.map((r) => (
                      <li key={r.receipt.receiptId} className="wf-task-card-whisper">
                        <span className="wf-task-card-whisper-sender">
                          {r.receipt.status === "achieved" ? "Achieved" : r.receipt.status === "failed" ? "Failed" : r.receipt.status === "blocked" ? "Blocked" : "Needs a decision"}
                          {" · "}{(r.receipt.evidence as unknown[]).length} evidence item{(r.receipt.evidence as unknown[]).length === 1 ? "" : "s"}
                        </span>
                        {r.receipt.unresolvedRisks.length > 0 && (
                          <span className="wf-task-card-whisper-body">Unresolved: {r.receipt.unresolvedRisks.join(", ")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}
