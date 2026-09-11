"use client";

import { useEffect, useState } from "react";
import { StatusLozenge, Surface, Meta, type LozengeTone } from "@/components/product/WorkspaceUI";

/**
 * WirePanel — polls /api/agent/wire every 7s and renders recent Dispatches.
 * ----------------------------------------------------------------------------
 * Same shape as LiveRunsPanel.tsx (poll → seed with server-rendered initial
 * data → no empty flash), but for the Wire instead of raw run rows. Status-only
 * telemetry: type, sender, summary. Never shows source or secrets (the API
 * never returns them — see dispatch.ts's validation before anything is stored).
 */

export interface WireDispatch {
  id: string;
  runId: string;
  type: string;
  sender: string;
  summary: string;
  resolutionState: string;
  createdAt: string;
}

export const TYPE_LABEL: Record<string, string> = {
  RUN_STARTED: "Run started",
  SCOPE_ANNOUNCED: "Scope announced",
  WORKING: "Working",
  PHASE_CHANGED: "Phase changed",
  BLOCKED: "Blocked",
  HUMAN_DECISION_REQUIRED: "Decision required",
  EVIDENCE_READY: "Evidence ready",
  RUN_COMPLETED: "Run completed",
};

export function typeTone(type: string): LozengeTone {
  if (type === "RUN_COMPLETED" || type === "EVIDENCE_READY") return "ok";
  if (type === "BLOCKED" || type === "HUMAN_DECISION_REQUIRED") return "warn";
  if (type === "RUN_STARTED" || type === "WORKING") return "info";
  return "neutral";
}

function rel(ts: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
const short = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

export default function WirePanel({
  initialDispatches,
  emptyHint,
}: {
  initialDispatches: WireDispatch[];
  emptyHint?: string;
}) {
  const [dispatches, setDispatches] = useState<WireDispatch[]>(initialDispatches);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/agent/wire", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { dispatches?: WireDispatch[] };
        if (!cancelled && Array.isArray(data.dispatches)) {
          setDispatches(data.dispatches);
          setLive(true);
        }
      } catch {
        /* transient — keep last known dispatches */
      }
    }
    const id = setInterval(poll, 7000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (dispatches.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
        {emptyHint ?? "The Wire is quiet. Dispatches appear here as runs start, change phase, or evidence is recorded."}
      </p>
    );
  }

  // Group by run — each run collapses into one row (latest event + count),
  // expandable to the full sequence. Keeps a busy floor from flooding the panel.
  const groups: { runId: string; events: WireDispatch[] }[] = [];
  const indexByRun = new Map<string, number>();
  for (const d of dispatches) {
    const existing = indexByRun.get(d.runId);
    if (existing === undefined) {
      indexByRun.set(d.runId, groups.length);
      groups.push({ runId: d.runId, events: [d] });
    } else {
      groups[existing].events.push(d);
    }
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
        <span className="text-[color:var(--ol-text-faint)]">· {groups.length} run{groups.length === 1 ? "" : "s"}</span>
      </div>
      <div className="wf-no-scrollbar max-h-80 space-y-2 overflow-y-auto pr-1">
        {groups.map((group) => (
          <WireRunGroup key={group.runId} runId={group.runId} events={group.events} />
        ))}
      </div>
    </div>
  );
}

function WireRunGroup({ runId, events }: { runId: string; events: WireDispatch[] }) {
  const [expanded, setExpanded] = useState(false);
  const latest = events[0];
  if (events.length === 1) {
    return (
      <Surface variant="row" className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 truncate text-sm text-[color:var(--ol-text-primary)]">{latest.summary}</div>
          <StatusLozenge tone={typeTone(latest.type)} dot>
            {TYPE_LABEL[latest.type] ?? latest.type}
          </StatusLozenge>
        </div>
        <Meta className="mt-2 justify-between">
          <span>{latest.sender}</span>
          <span>run {short(latest.runId)} · {rel(latest.createdAt)}</span>
        </Meta>
      </Surface>
    );
  }

  return (
    <Surface variant="row" className="p-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 truncate text-sm text-[color:var(--ol-text-primary)]">{latest.summary}</div>
          <StatusLozenge tone={typeTone(latest.type)} dot>
            {TYPE_LABEL[latest.type] ?? latest.type}
          </StatusLozenge>
        </div>
        <Meta className="mt-2 justify-between">
          <span>{latest.sender} · {events.length} events {expanded ? "▲" : "▼"}</span>
          <span>run {short(runId)} · {rel(latest.createdAt)}</span>
        </Meta>
      </button>
      {expanded && (
        <div className="border-t border-[color:var(--ol-border-subtle)] px-3 pb-3">
          {events.slice(1).map((d) => (
            <div key={d.id} className="flex items-start justify-between gap-3 border-b border-[color:var(--ol-border-subtle)] py-2 last:border-b-0">
              <div className="min-w-0 truncate text-[12px] text-[color:var(--ol-text-secondary)]">{d.summary}</div>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusLozenge tone={typeTone(d.type)} dot>
                  {TYPE_LABEL[d.type] ?? d.type}
                </StatusLozenge>
                <span className="text-[10px] text-[color:var(--ol-text-faint)]">{rel(d.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Surface>
  );
}
