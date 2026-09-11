"use client";

import { useEffect, useState } from "react";
import {
  buildAgentTrackRecord,
  trackRecordStandingLabel,
  type TrackRecordPassport,
  type TrackRecordRun,
  type TrackRecordStanding,
} from "@/lib/agent-track-record";

/**
 * AgentTrackRecord — one slim band under the Watchfloor for the selected agent:
 * its retained history of runs, human review decisions, and command-tied
 * verification results. Every figure is a count of retained records; the
 * standing label is threshold-gated in the lib and never a synthetic score.
 */

const STANDING_TONE: Record<TrackRecordStanding, string> = {
  no_record: "border-[color:var(--ol-border-default)] text-[color:var(--ol-text-muted)]",
  building: "border-[color:var(--ol-border-default)] text-[color:var(--ol-text-secondary)]",
  consistent: "border-[color:var(--ol-ok-border)] text-[color:var(--ol-ok)]",
  attention: "border-[color:var(--ol-warn-border)] text-[color:var(--ol-warn)]",
};

function relTime(value: string | null, nowMs: number): string | null {
  if (!value) return null;
  const secs = Math.floor((nowMs - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 0) return null;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const DECISION_LABEL: Record<string, string> = {
  reviewed: "reviewed",
  needs_follow_up: "needs follow-up",
  not_accepted: "not accepted",
};

export default function AgentTrackRecord({
  agentLabel,
  runs,
  passports,
}: {
  agentLabel: string;
  runs: TrackRecordRun[];
  passports: TrackRecordPassport[];
}) {
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const initial = window.setTimeout(() => setNowMs(Date.now()), 0);
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(id);
    };
  }, []);
  const record = buildAgentTrackRecord(runs, passports);
  const lastAt = record.lastDecision ? relTime(record.lastDecision.reviewedAt, nowMs) : null;

  return (
    <section
      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-[color:var(--ol-border-subtle)] px-3 py-2"
      aria-label={`${agentLabel} track record`}
      data-standing={record.standing}
    >
      <span className="wf-micro text-[color:var(--ol-text-faint)]">Track record</span>
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STANDING_TONE[record.standing]}`}
      >
        {trackRecordStandingLabel(record.standing)}
      </span>

      {record.decided > 0 ? (
        <span className="ol-mono flex flex-wrap items-center gap-x-3 text-[11px] text-[color:var(--ol-text-muted)]">
          <span>
            <b className="text-[color:var(--ol-text-primary)]">{record.runsTotal}</b> run{record.runsTotal === 1 ? "" : "s"}
          </span>
          <span>
            <b className="text-[color:var(--ol-text-primary)]">{record.reviewed}</b> reviewed
          </span>
          {record.needsFollowUp > 0 && (
            <span>
              <b className="text-[color:var(--ol-warn)]">{record.needsFollowUp}</b> follow-up
            </span>
          )}
          {record.notAccepted > 0 && (
            <span>
              <b className="text-[color:var(--ol-danger)]">{record.notAccepted}</b> not accepted
            </span>
          )}
          {record.verificationRan > 0 && (
            <span>
              verification clean <b className="text-[color:var(--ol-text-primary)]">{record.verificationClean}/{record.verificationRan}</b>
            </span>
          )}
          {record.reworkSignals > 0 && (
            <span title="Files from a reviewed run were later touched by another run's evidence. Treat it as a signal worth checking.">
              rework signal <b className="text-[color:var(--ol-warn)]">{record.reworkSignals}</b>
            </span>
          )}
          {record.approvalRate !== null && (
            <span>
              approval <b className="text-[color:var(--ol-text-primary)]">{Math.round(record.approvalRate * 100)}%</b>
            </span>
          )}
          {record.lastDecision && (
            <span>
              last decision {DECISION_LABEL[record.lastDecision.decision] ?? record.lastDecision.decision}
              {lastAt ? ` · ${lastAt}` : ""}
            </span>
          )}
        </span>
      ) : (
        <span className="text-[11px] text-[color:var(--ol-text-muted)]">
          No reviewed runs yet. The record builds from human review decisions on this agent&apos;s Run Passports.
        </span>
      )}
    </section>
  );
}
