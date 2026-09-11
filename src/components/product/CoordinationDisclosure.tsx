"use client";

import { useEffect, useState } from "react";

import type {
  CoordinationOutcomeEvaluation,
  CoordinationValueDecision,
} from "@/lib/coordination-value-gate";
import { humanizeEnumLabel } from "@/lib/format-enum-label";

/**
 * CoordinationDisclosure — the Watchfloor's honest account of multi-agent
 * coordination cost and quality.
 * ----------------------------------------------------------------------------
 * Truth contract:
 *  - Solo is the default delivery. This panel never suggests adding an agent.
 *  - Every figure is sourced: live residents from retained lease rows,
 *    decisions/evaluations from the deterministic coordination gate
 *    (coordination-value-gate — rendered here, never recomputed or invented).
 *  - "Quality improved" appears ONLY when a gate evaluation with comparable
 *    objective evidence says mayClaimQualityImprovement. Anything else renders
 *    the verdict the gate actually returned, reasons included.
 */

export interface DisclosureResident {
  id: string;
  provider: string;
  lease_expires_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** A gate decision plus the sourced ceilings it was made against. */
export interface DisclosureDecision {
  id: string;
  requestType: "HELP_REQUESTED" | "CHECK_REQUESTED";
  decision: CoordinationValueDecision;
  maxEstimatedTokens: number | null;
  maxAddedLatencyMs: number | null;
}

const REASON_LABEL: Record<string, string> = {
  coordination_need_not_declared: "no coordination need declared",
  assurance_requires_check_request: "assurance requires a check request",
  distinct_capability_required: "no distinct capability named",
  objective_success_criteria_required: "no objective success criteria",
  similar_request_already_open: "similar request already open",
  token_budget_required: "no token ceiling declared",
  token_budget_exceeded: "token ceiling exceeded",
  latency_budget_exceeded: "latency ceiling exceeded",
  objective_evidence_missing: "objective evidence missing",
  usage_evidence_missing: "usage evidence missing",
  objective_quality_not_improved: "objective quality not improved",
  token_overhead_exceeded: "token overhead exceeded",
  latency_overhead_exceeded: "latency overhead exceeded",
  quality_per_token_not_improved: "quality per token not improved",
};

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? humanizeEnumLabel(reason);
}

const VERDICT_COPY: Record<CoordinationOutcomeEvaluation["verdict"], string> = {
  improved: "Quality improved vs. the solo baseline (comparable objective evidence)",
  not_improved: "No quality improvement vs. the solo baseline",
  insufficient_data: "Insufficient comparable evidence for a quality claim",
};

export default function CoordinationDisclosure({
  residents,
  decisions = [],
  evaluations = [],
  nowMs,
}: {
  residents: DisclosureResident[];
  decisions?: DisclosureDecision[];
  evaluations?: Array<{ id: string; evaluation: CoordinationOutcomeEvaluation }>;
  nowMs?: number;
}) {
  const [observedNow, setObservedNow] = useState<number | null>(nowMs ?? null);
  useEffect(() => {
    if (nowMs != null) return;
    const timer = window.setTimeout(() => setObservedNow(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, [nowMs]);
  const liveResidents = residents.filter(
    (resident) => observedNow !== null && !resident.revoked_at && Date.parse(resident.lease_expires_at ?? "") > observedNow,
  );

  return (
    <section
      className="mt-3 rounded-md border border-[color:var(--ol-border-subtle)] px-4 py-3"
      aria-label="Coordination disclosure"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="ol-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--ol-text-muted)]">
          Coordination
        </span>
        <span className="text-[11px] text-[color:var(--ol-text-muted)]">
          Solo is the default. Coordination runs only under explicit token and latency ceilings.
        </span>
      </div>

      <div className="ol-mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[color:var(--ol-text-muted)]">
        <span>
          <b className="text-[color:var(--ol-text-primary)]">{liveResidents.length}</b> live resident{liveResidents.length === 1 ? "" : "s"}
        </span>
        {liveResidents.slice(0, 4).map((resident) => (
          <span key={resident.id}>{resident.provider} · lease live</span>
        ))}
        <span>
          <b className="text-[color:var(--ol-text-primary)]">{decisions.length}</b> gate decision{decisions.length === 1 ? "" : "s"} recorded
        </span>
      </div>

      {decisions.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Coordination gate decisions">
          {decisions.map((item) => (
            <li key={item.id} className="ol-mono flex flex-wrap items-center gap-x-3 text-[11px] text-[color:var(--ol-text-muted)]">
              <span className="text-[color:var(--ol-text-secondary)]">{humanizeEnumLabel(item.requestType)}</span>
              <span className={item.decision.delivery === "coordinate" ? "text-[color:var(--ol-ok)]" : "text-[color:var(--ol-text-primary)]"}>
                {item.decision.delivery === "coordinate" ? "coordinate" : "kept solo"}
              </span>
              {item.decision.delivery === "coordinate" ? (
                <span>
                  ceilings: {item.maxEstimatedTokens != null ? `${item.maxEstimatedTokens.toLocaleString()} tokens` : "tokens undeclared"}
                  {" · "}
                  {item.maxAddedLatencyMs != null ? `${item.maxAddedLatencyMs.toLocaleString()} ms added latency` : "latency undeclared"}
                </span>
              ) : (
                <span>{item.decision.reasons.map(reasonLabel).join(" · ")}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {evaluations.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Coordination outcome evaluations">
          {evaluations.map(({ id, evaluation }) => (
            <li key={id} className="ol-mono flex flex-wrap items-center gap-x-3 text-[11px] text-[color:var(--ol-text-muted)]">
              <span
                className={
                  evaluation.mayClaimQualityImprovement
                    ? "text-[color:var(--ol-ok)]"
                    : evaluation.verdict === "not_improved"
                      ? "text-[color:var(--ol-warn)]"
                      : "text-[color:var(--ol-text-secondary)]"
                }
              >
                {VERDICT_COPY[evaluation.verdict]}
              </span>
              {evaluation.tokenDelta !== null && <span>token delta {evaluation.tokenDelta >= 0 ? "+" : ""}{evaluation.tokenDelta.toLocaleString()}</span>}
              <span>latency delta {evaluation.durationDeltaMs >= 0 ? "+" : ""}{evaluation.durationDeltaMs.toLocaleString()} ms</span>
              {!evaluation.mayClaimQualityImprovement && evaluation.reasons.length > 0 && (
                <span>{evaluation.reasons.map(reasonLabel).join(" · ")}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {decisions.length === 0 && evaluations.length === 0 && (
        <p className="mt-2 text-[11px] text-[color:var(--ol-text-muted)]">
          No coordination requests recorded. Quality improvement is never claimed without comparable objective evidence from a solo baseline.
        </p>
      )}
    </section>
  );
}
