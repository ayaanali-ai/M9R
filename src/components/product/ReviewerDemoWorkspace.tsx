"use client";

import { useState } from "react";

const panels = [
  ["Rules", "Active repo rules", ["Scope: dashboard reviewer demo only", "Evidence: lint, typecheck, build, tests, and diff review", "Restricted: auth, billing, secrets, and production data"]],
  ["Controlled run", "Run OL-DEMO-002", ["Agent: Codex CLI", "Rules loaded: 3 active rules", "State: evidence submitted and awaiting human review"]],
  ["Evidence", "Approved and redacted", ["Lint: passed", "Typecheck: passed", "Tests: targeted checks passed", "Diff: scoped; secrets excluded"]],
  ["Run Passport", "Review record", ["Active rules, evidence, verification signals, and redactions", "Review status: needs a human decision"]],
  ["Compare", "Baseline and controlled run", ["Rules loaded: 0 → 3", "Verification: missing → present", "The record shows changed signals; it makes no claim about correctness or causation"]],
] as const;

export default function ReviewerDemoWorkspace() {
  const [decision, setDecision] = useState<"Approve" | "Needs changes" | "Reject" | null>(null);
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] p-5 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ol-accent)]">YC reviewer workspace</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-[color:var(--ol-text-primary)]">A seeded control-board record for one agent run.</h2>
        <p className="mt-2 text-sm leading-6 text-[color:var(--ol-text-secondary)]">Demo workspace. Seeded/redacted evidence. Review aid only.</p>
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        {panels.map(([eyebrow, title, rows]) => <section key={eyebrow} className="rounded-lg border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-5"><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ol-accent)]">{eyebrow}</p><h3 className="mt-2 text-lg font-semibold text-[color:var(--ol-text-primary)]">{title}</h3><ul className="mt-4 space-y-2 text-sm leading-6 text-[color:var(--ol-text-secondary)]">{rows.map((row) => <li key={row}>{row}</li>)}</ul></section>)}
        <section className="rounded-lg border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ol-accent)]">Human review</p>
          <h3 className="mt-2 text-lg font-semibold text-[color:var(--ol-text-primary)]">Review before trust</h3>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">{(["Approve", "Needs changes", "Reject"] as const).map((option) => <button key={option} type="button" onClick={() => setDecision(option)} aria-pressed={decision === option} className="rounded-md border border-[color:var(--ol-border-default)] px-4 py-3 text-sm text-[color:var(--ol-text-secondary)]">{option}</button>)}</div>
          <p className="mt-4 text-sm text-[color:var(--ol-text-muted)]">Selected: <span className="text-[color:var(--ol-text-primary)]">{decision ?? "No decision"}</span></p>
          <p className="mt-1 text-xs text-[color:var(--ol-text-faint)]">Demo choice, stored only in this page state. No production record is changed.</p>
        </section>
      </div>
      <p className="border-l-2 border-[color:var(--ol-accent)] bg-black/10 px-4 py-3 text-sm leading-6 text-[color:var(--ol-text-muted)]">M9R records rules, evidence, and review decisions. It does not prove code correctness.</p>
    </div>
  );
}
