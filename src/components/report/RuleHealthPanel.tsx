import React from "react";
import type { RuleHealthReport, RuleHealthStatus } from "@/lib/rule-health";
import {
  RULE_HEALTH_EMPTY_COPY,
  STATUS_COPY,
  STATUS_LABEL,
  STATUS_TONE,
  STATUS_ORDER,
  TONE_CHIP,
  evidenceChipClass,
} from "@/lib/rule-health-display";

/**
 * RuleHealthPanel — surfaces how a session's loaded workspace rules fared.
 *
 * Display only. It renders the classifier's output verbatim (rule-health.ts) and
 * never re-judges anything. Copy is deliberately conservative: a rule is only
 * ever described as having "held", never as having passed or worked.
 *
 * Pass the `rule_health` object from the /api/agent/session response. When it's
 * absent (e.g. the plain analyze flow loads no rules) the panel renders nothing;
 * when it's present but not evaluated, it shows an honest empty state.
 */
export function RuleHealthPanel({
  ruleHealth,
  className,
}: {
  ruleHealth?: RuleHealthReport | null;
  className?: string;
}) {
  if (!ruleHealth) return null;

  return (
    <section
      className={`rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 ${className ?? ""}`}
      aria-label="Rule health"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-100">Rule health</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
          loaded rules: {ruleHealth.items.length}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
        How the workspace rules this session loaded held up against what was observed.
      </p>

      {!ruleHealth.evaluated ? (
        <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-[12px] text-zinc-400">
          {RULE_HEALTH_EMPTY_COPY}
        </p>
      ) : (
        <>
          {/* Summary chips — every bucket, in a stable order. */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {STATUS_ORDER.map((status) => {
              const count = ruleHealth.summary[status] ?? 0;
              return (
                <span
                  key={status}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium leading-none ${
                    count > 0 ? TONE_CHIP[STATUS_TONE[status]] : "border-white/[0.06] bg-transparent text-zinc-600"
                  }`}
                >
                  {STATUS_LABEL[status]} {count}
                </span>
              );
            })}
          </div>

          {/* Per-rule detail. */}
          <ul className="mt-3 space-y-2.5">
            {ruleHealth.items.map((item) => {
              const status = item.status as RuleHealthStatus;
              const matched = item.matchedFindingTypes ?? [];
              return (
                <li
                  key={item.rule_id}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-1 text-[10px] font-medium leading-none ${TONE_CHIP[STATUS_TONE[status]]}`}
                    >
                      {STATUS_LABEL[status]}
                    </span>
                    <span className="text-[13px] font-medium text-zinc-100">{item.title}</span>
                    {item.evidenceLevel && (
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-1 font-mono text-[9px] uppercase tracking-wide leading-none ${evidenceChipClass(
                          item.evidenceLevel,
                        )}`}
                      >
                        {item.evidenceLevel}
                      </span>
                    )}
                  </div>

                  <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-400">
                    <span className="text-zinc-300">{STATUS_COPY[status]}</span>{" "}
                    {item.reason}
                  </p>

                  {matched.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[9px] uppercase tracking-wide text-zinc-600">
                        matched findings:
                      </span>
                      {matched.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-zinc-400"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export default RuleHealthPanel;
