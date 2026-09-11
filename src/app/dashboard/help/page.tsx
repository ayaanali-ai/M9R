import Link from "next/link";
import { PageHeader, Surface, Section } from "@/components/product/WorkspaceUI";

const helpItems = [
  {
    question: "What is a Run Passport?",
    answer:
      "A Run Passport is a review record for an AI coding-agent session: active rules, submitted evidence, verification signals, redactions, and human review status.",
  },
  {
    question: "What evidence should I submit?",
    answer:
      "Approved/redacted evidence such as lint, test, build, diff, command output, or summaries that do not contain secrets.",
  },
  {
    question: "What rules should I create?",
    answer:
      "Rules that constrain agent behavior: do not touch unrelated files, do not claim tests passed without evidence, do not expand scope, and do not modify sensitive areas without approval.",
  },
  {
    question: "What does M9R not prove?",
    answer:
      "M9R does not prove code correctness, replace code review, or guarantee safety. It records rules, evidence, and review decisions before trust.",
  },
] as const;

export default function HelpPage() {
  return (
    <>
      <PageHeader
        eyebrow="Registry"
        title="Help"
        description="How M9R works, what to submit, and where the review boundary sits."
        aside={
          <Link href="/dashboard/help?tour=1" prefetch={false} className="ol-btn ol-btn--secondary">
            Start product tour →
          </Link>
        }
      />

      <Surface className="mt-6 p-5 sm:p-6" style={{ borderRadius: "var(--ol-radius-lg)" }}>
        <p className="ol-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--ol-text-faint)]">How M9R works</p>
        <h2 className="mt-2 text-lg font-semibold tracking-tight text-[color:var(--ol-text-primary)]">
          Rules before the run. Evidence after the run.
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--ol-text-secondary)]">
          Follow the seeded flow from active repo rules through controlled handoff, approved evidence,
          a Run Passport, run comparison, and a human review decision.
        </p>
        <p
          className="mt-5 border-l-2 px-4 py-3 text-xs leading-6 text-[color:var(--ol-text-muted)]"
          style={{ borderColor: "var(--accent)", background: "var(--ol-surface-2)", borderRadius: "var(--ol-radius-sm)" }}
        >
          Start with Rules, inspect the controlled run, review submitted evidence and the Run Passport, then make a human review decision.
        </p>
      </Surface>

      <div className="mt-6">
        <Section title="Questions">
          <Surface className="divide-y divide-[color:var(--ol-border-subtle)] overflow-hidden p-0">
            {helpItems.map((item) => (
              <div key={item.question} className="grid gap-1 px-5 py-4 sm:grid-cols-[1fr_1.4fr] sm:gap-6">
                <h3 className="text-sm font-semibold text-[color:var(--ol-text-primary)]">{item.question}</h3>
                <p className="text-xs leading-6 text-[color:var(--ol-text-muted)]">{item.answer}</p>
              </div>
            ))}
          </Surface>
        </Section>
      </div>

      <p className="mt-6 flex items-center gap-3 border-t border-[color:var(--ol-border-subtle)] pt-4 ol-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--ol-text-faint)]">
        <span>M9R · RECORD.V1</span>
        <span aria-hidden>·</span>
        <span>Records rules, evidence, and review decisions, without judging code correctness.</span>
      </p>
    </>
  );
}
