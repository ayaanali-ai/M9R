"use client";

import { useState } from "react";
import { buildAgentTrackRecord, trackRecordStandingLabel } from "@/lib/agent-track-record";
import type { RunPassport } from "@/lib/run-passport-service";
import type { AgentView, WsRun } from "@/lib/agent-workspace-data";

/**
 * Shared helpers, cross-cutting formatting, and small primitives used across
 * multiple agent-workspace files (split out of AgentWorkspaceClient.tsx).
 */

export type Selected = string | "all";
/**
 * The run drawer's only focusable zone. "passport"/"review" were the other two
 * and both navigated to the retired /dashboard/runs/[id] Run Passport page --
 * that surface, and the passport document itself, were cut.
 */
export type RunZone = "evidence";

export const short = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

export function relAt(value: string | null, nowMs: number): string {
  if (!value) return "never";
  const secs = Math.max(0, Math.floor((nowMs - new Date(value).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function byLastSeen(a: WsRun, b: WsRun) { return new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime(); }

export function agentForRun(agents: AgentView[], run: WsRun): AgentView | null {
  return agents.find((agent) => agent.runs.some((candidate) => candidate.id === run.id))
    ?? agents.find((agent) => agent.key === run.agent_kind)
    ?? null;
}

/**
 * One-line track record beside an agent's pending decisions: retained review
 * counts only (agent-track-record lib), shown when at least one decision
 * exists — an empty record stays silent rather than implying a standing.
 */
export function ApprovalRecordLine({ agent, passports }: { agent: AgentView; passports: RunPassport[] }) {
  const record = buildAgentTrackRecord(agent.runs, passports);
  if (record.decided === 0) return null;
  return (
    <span className="ol-mono ml-auto text-[10px] text-[color:var(--ol-text-faint)]" title={trackRecordStandingLabel(record.standing)}>
      record: {record.reviewed} reviewed
      {record.needsFollowUp > 0 && ` · ${record.needsFollowUp} follow-up`}
      {record.notAccepted > 0 && <span className="text-[color:var(--ol-danger)]"> · {record.notAccepted} not accepted</span>}
      {record.approvalRate !== null && ` · ${Math.round(record.approvalRate * 100)}%`}
    </span>
  );
}

export function KeyMap({ onClose }: { onClose: () => void }) {
  const keys: Array<[string, string]> = [
    ["j / k", "Next / previous run"],
    ["Enter", "Open the selected Run Passport"],
    ["r", "Focus the review decision block"],
    ["a", "Open Ready for Review"],
    ["?", "Toggle this map"],
  ];
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-end p-4" role="dialog" aria-label="Keyboard map">
      <button type="button" className="absolute inset-0" aria-label="Close keyboard map" onClick={onClose} />
      <div className="relative w-72 rounded-lg border border-[color:var(--ol-border-strong)] bg-[color:var(--ol-surface-1)] p-4 shadow-2xl">
        <div className="wf-micro text-[color:var(--ol-text-faint)]">Operator keys</div>
        <dl className="mt-2 space-y-1.5">
          {keys.map(([key, action]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <dt className="ol-mono rounded border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] px-1.5 py-0.5 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)]">{key}</dt>
              <dd className="text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function CopyButton({ text, label, className, copiedLabel, children }: {
  text: string;
  label: string;
  className?: string;
  copiedLabel?: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
      }}
      className={className ?? "shrink-0 rounded-md bg-[color:var(--ol-surface-2)] px-2 py-1 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)] transition-colors hover:bg-[color:var(--ol-surface-3)]"}
    >
      {copied ? (copiedLabel ?? "Copied") : (children ?? "Copy")}
    </button>
  );
}

export function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-[color:var(--ol-surface-2)] px-1 py-0.5 font-mono text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)]">{children}</code>;
}
