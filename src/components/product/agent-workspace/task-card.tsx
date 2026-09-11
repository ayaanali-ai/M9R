"use client";

/**
 * Task Card — item #4's visible half. The backend (decomposition, dispatch,
 * no-repeat/hard-cap reassignment safety) already existed and runs for real;
 * this is the piece that was missing entirely: a clean, high-signal summary
 * of a team task in the main channel, with the actual agent-to-agent
 * chatter folded into a collapsible "Whispers" drawer instead of cluttering
 * the feed. See M9R_MASTER_BUILD_PLAN.md item #4 for the full spec this
 * implements.
 *
 * Deliberately its own file, not another few hundred lines in
 * ConversationPanel.tsx -- that file is already the single largest in the
 * repo (see item #18's file-size audit), and this card's data (contract +
 * items) and behavior (fetch-on-expand whispers) are self-contained enough
 * to not need any of that file's own state.
 */

import { useState } from "react";
import { AgentMark, AGENT_BRAND_COLOR } from "@/components/product/WorkspaceUI";
import type { AgentView } from "@/lib/agent-workspace-data";

export type TaskContractItemStatus = "pending" | "in_progress" | "blocked" | "done" | "failed";
export type TaskContractStatus = "decomposing" | "executing" | "completed" | "failed";

export interface TaskCardItem {
  id: string;
  description: string;
  status: TaskContractItemStatus;
  assignedConnectionId: string | null;
  reassignmentCount: number;
  resultMessageId: string | null;
}

export interface TaskCardContract {
  id: string;
  conversationId: string;
  anchorMessageId: string;
  status: TaskContractStatus;
  decomposedByConnectionId: string | null;
  createdAt: string;
  items: TaskCardItem[];
}

interface TaskContractWhisper {
  id: string;
  body: string;
  kind: string;
  senderConnectionId: string | null;
  createdAt: string;
}

const CONTRACT_STATUS_LABEL: Record<TaskContractStatus, string> = {
  decomposing: "Splitting up the work",
  executing: "In progress",
  completed: "Completed",
  failed: "Needs attention",
};

const ITEM_STATUS_LABEL: Record<TaskContractItemStatus, string> = {
  pending: "Pending",
  in_progress: "Working",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
};

function timeAgo(iso: string, nowMs: number | null): string {
  const deltaSeconds = Math.max(0, Math.round(((nowMs ?? Date.now()) - Date.parse(iso)) / 1000));
  if (deltaSeconds < 60) return "just now";
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function TaskCard({
  contract,
  byConnectionId,
  nowMs,
  onJumpToMessage,
}: {
  contract: TaskCardContract;
  byConnectionId: Map<string, AgentView>;
  nowMs: number | null;
  onJumpToMessage: (messageId: string) => void;
}) {
  const [whispersOpen, setWhispersOpen] = useState(false);
  const [whispers, setWhispers] = useState<TaskContractWhisper[] | null>(null);
  const [whispersError, setWhispersError] = useState<string | null>(null);
  const [whispersLoading, setWhispersLoading] = useState(false);

  const decomposer = contract.decomposedByConnectionId ? byConnectionId.get(contract.decomposedByConnectionId) ?? null : null;

  async function toggleWhispers() {
    const next = !whispersOpen;
    setWhispersOpen(next);
    if (next && whispers === null && !whispersLoading) {
      setWhispersLoading(true);
      setWhispersError(null);
      try {
        const res = await fetch(`/api/dashboard/task-contracts/${encodeURIComponent(contract.id)}/whispers`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { whispers?: TaskContractWhisper[]; error?: string };
        if (!res.ok) { setWhispersError(body.error || "Could not load whispers."); return; }
        setWhispers(body.whispers ?? []);
      } catch {
        setWhispersError("Could not reach the server.");
      } finally {
        setWhispersLoading(false);
      }
    }
  }

  return (
    <div className="wf-task-card" data-status={contract.status} role="group" aria-label="Team task">
      <div className="wf-task-card-header">
        <span className="wf-task-card-dot" aria-hidden />
        TEAM TASK
        <span className="wf-task-card-header-status">{CONTRACT_STATUS_LABEL[contract.status]}</span>
      </div>
      {decomposer && (
        <div className="wf-task-card-subject">
          <AgentMark agentKey={decomposer.key} size={16} />
          <strong>{decomposer.label}</strong>&nbsp;split this into {contract.items.length} {contract.items.length === 1 ? "piece" : "pieces"}
        </div>
      )}
      <ul className="wf-task-card-items">
        {contract.items.map((item) => {
          const agent = item.assignedConnectionId ? byConnectionId.get(item.assignedConnectionId) ?? null : null;
          return (
            <li key={item.id} className="wf-task-card-item">
              <span className="wf-task-card-item-agent" style={{ color: agent ? AGENT_BRAND_COLOR[agent.key] ?? "var(--ol-text-primary)" : undefined }}>
                {agent && <AgentMark agentKey={agent.key} size={14} />}
                {agent?.label ?? "Unassigned"}
              </span>
              <span className="wf-task-card-item-description">{item.description}</span>
              <span className="wf-activity-row-badge" data-status={item.status === "done" ? "ready" : item.status === "failed" || item.status === "blocked" ? "denied" : item.status === "in_progress" ? "pending" : "idle"}>
                {ITEM_STATUS_LABEL[item.status]}
              </span>
              {item.resultMessageId && (item.status === "done" || item.status === "failed") && (
                <button type="button" className="wf-btn-ghost-sm" onClick={() => onJumpToMessage(item.resultMessageId!)}>View</button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="wf-task-card-footer">
        <button type="button" className="wf-task-card-whispers-toggle" onClick={() => void toggleWhispers()} aria-expanded={whispersOpen}>
          <span className={whispersOpen ? "wf-task-card-chevron is-open" : "wf-task-card-chevron"} aria-hidden>›</span>
          Whispers
        </button>
        <span className="ol-mono wf-task-card-meta">{timeAgo(contract.createdAt, nowMs)}</span>
      </div>
      {whispersOpen && (
        <div className="wf-task-card-whispers">
          {whispersLoading ? (
            <p className="wf-task-card-whispers-empty">Loading…</p>
          ) : whispersError ? (
            <p className="wf-task-card-whispers-empty">{whispersError}</p>
          ) : !whispers || whispers.length === 0 ? (
            <p className="wf-task-card-whispers-empty">No agent-to-agent chatter recorded for this task yet.</p>
          ) : (
            <ul className="wf-task-card-whispers-list">
              {whispers.map((whisper) => {
                const sender = whisper.senderConnectionId ? byConnectionId.get(whisper.senderConnectionId) ?? null : null;
                return (
                  <li key={whisper.id} className="wf-task-card-whisper">
                    <span className="wf-task-card-whisper-sender">{sender?.label ?? "Agent"}</span>
                    <span className="wf-task-card-whisper-body">{whisper.body}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
