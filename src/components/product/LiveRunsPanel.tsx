"use client";

import { useEffect, useState } from "react";
import { StatusLozenge, Surface, Meta, type LozengeTone } from "@/components/product/WorkspaceUI";
import { normalizeAgentKind } from "@/lib/agent-workspace-data";
import type { AgentPresenceState } from "@/lib/agent-presence";

/**
 * LiveRunsPanel — polls /api/agent/runs every 7s and renders current/recent runs
 * on the ol-* token system. No WebSockets. Conservative, status-only telemetry:
 * phase, rules-loaded count, whether a session was submitted. Never shows source
 * or secrets (the API never returns them).
 *
 * Reused in two places: the /dashboard Overview (all agents) and the Agent
 * Workspace Runs tab (filtered to the selected agent kind via `agentKind`).
 * Server-rendered `initialRuns` seed it so there is no empty flash before the
 * first poll resolves.
 *
 * Gate 4: the badge is driven by the server's presence derivation
 * (deriveAgentPresence — Gate 1), not run.status directly. That model already
 * distinguishes stale/disconnected/error from working/waiting, so a run whose
 * connection went quiet reads as "Stale" or "Disconnected" instead of forever
 * showing its last-known status as if it were still true.
 */

export interface LiveRun {
  id: string;
  agent_kind: string | null;
  repo_hint: string | null;
  task_title: string | null;
  status: string;
  current_phase: string | null;
  rules_loaded_count: number;
  latest_session_id: string | null;
  last_seen_at: string;
  /** Server-derived (Gate 1). Absent only if the connection lookup itself failed — never fabricated client-side. */
  presence?: { state: AgentPresenceState; label: string; truth: "observed" | "unknown"; lastConfirmedAt: string | null };
  execution_origin?: "linked" | "resident" | null;
}

/** Map a real presence state to a lozenge tone. Distinct from run.status: this is what actually happened, not what was last requested. */
function presenceTone(state: AgentPresenceState): LozengeTone {
  switch (state) {
    case "working":
      return "info";
    case "awake":
      return "info";
    case "waiting":
      return "warn";
    case "evidence":
      return "warn";
    case "stale":
      return "stale";
    case "asleep":
      return "neutral";
    case "disconnected":
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function originLabel(origin: "linked" | "resident" | null | undefined): string | null {
  if (origin === "resident") return "resident";
  if (origin === "linked") return "linked";
  return null;
}

function rel(ts: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
const short = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

export default function LiveRunsPanel({
  initialRuns,
  agentKind,
  emptyHint,
}: {
  initialRuns: LiveRun[];
  /** When set, only runs from this agent_kind are shown (workspace Runs tab). */
  agentKind?: string | null;
  emptyHint?: string;
}) {
  const [runs, setRuns] = useState<LiveRun[]>(initialRuns);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/agent/runs", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { runs?: LiveRun[] };
        if (!cancelled && Array.isArray(data.runs)) {
          setRuns(data.runs);
          setLive(true);
        }
      } catch {
        /* transient — keep last known runs */
      }
    }
    const id = setInterval(poll, 7000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const shown = agentKind ? runs.filter((r) => normalizeAgentKind(r.agent_kind) === agentKind) : runs;

  if (shown.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
        {emptyHint ?? "No runs yet. Start one with npx m9r-cli run start and it appears here with its live phase."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] text-[color:var(--ol-text-faint)]">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: live ? "var(--ol-ok)" : "var(--ol-border-strong)" }}
          aria-hidden
        />
        {live ? "Live, updating every 7s" : "Showing the latest snapshot"}
      </div>
      {shown.map((run) => (
        <Surface key={run.id} variant="row" className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[color:var(--ol-text-primary)]">
                {run.task_title || "Untitled run"}
              </div>
              <Meta className="mt-1">
                <span>{run.agent_kind || "agent"}</span>
                {originLabel(run.execution_origin) && <span>{originLabel(run.execution_origin)}</span>}
                {run.repo_hint && <span>{run.repo_hint}</span>}
                <span>{run.rules_loaded_count} rules loaded</span>
                {run.latest_session_id && <span>session submitted</span>}
              </Meta>
            </div>
            {run.presence ? (
              <StatusLozenge tone={presenceTone(run.presence.state)} dot>
                {run.presence.label}
              </StatusLozenge>
            ) : (
              <StatusLozenge tone="neutral" dot>
                Unknown
              </StatusLozenge>
            )}
          </div>
          <Meta className="mt-2 justify-between">
            <span className="truncate">{run.current_phase ? `phase: ${run.current_phase}` : "—"}</span>
            <span>
              run {short(run.id)} ·{" "}
              {run.presence?.lastConfirmedAt
                ? `confirmed ${rel(run.presence.lastConfirmedAt)}`
                : `last update unconfirmed (${rel(run.last_seen_at)})`}
            </span>
          </Meta>
        </Surface>
      ))}
    </div>
  );
}
