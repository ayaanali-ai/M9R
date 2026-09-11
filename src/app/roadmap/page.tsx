import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ScrollReveal from "@/components/ScrollReveal";
import type { Metadata } from "next";

/**
 * Roadmap — an honest ledger, not a vision arc.
 * ----------------------------------------------------------------------------
 * Three sections: Shipped (live today, each line links into the product as a
 * receipt), In progress, and Planned. No dates, no claims the product can't
 * back. Styled in the site-wide `.lp-*` language.
 */

export const metadata: Metadata = {
  title: "Roadmap — M9R",
  description:
    "What's live in M9R today, what's being built now, and what's planned next. Every shipped line links to the real thing.",
};

type Entry = {
  title: string;
  body: string;
  receipt?: { href: string; label: string };
};

const SHIPPED: Entry[] = [
  {
    title: "Evidence levels on every finding",
    body: "Inferred, correlated, or command-tied. If a run can't support a claim, the record says so.",
  },
  {
    title: "Workspace memory",
    body: "Confirm what an agent flagged; keep, rewrite, or archive it on evidence. Export what the team remembers to AGENTS.md, CLAUDE.md, or a Cursor rule.",
    receipt: { href: "/dashboard/memory", label: "Open Memory" },
  },
  {
    title: "Agent Workspace",
    body: "Per-agent workspaces, evidence, and approvals for Claude Code, Codex, and Grok Build, in one command center for the custody loop.",
    receipt: { href: "/dashboard/agents", label: "Open the workspace" },
  },
  {
    title: "The M9R CLI",
    body: "npx m9r-cli init connects an agent; submit-session seals a run; rules binds the next one. No SDK, no re-instrumentation.",
    receipt: { href: "/agents", label: "Connect your agent" },
  },
  {
    title: "Run A vs Run B",
    body: "Compare a later run against the sealed baseline and see whether retries and thrash actually fell, described conservatively.",
  },
  {
    title: "Billing for paid tiers",
    body: "Free stays free: up to 2 workspaces, up to 2 connected agents, the full governance loop. Pro is a real Stripe subscription, managed from your own billing portal.",
    receipt: { href: "/pricing", label: "See pricing" },
  },
  {
    title: "Real GitHub integration",
    body: "Push/PR/review activity from GitHub posts live into the channel it's bound to. An agent can propose a pull request; a human decision is the only thing that opens it for real. This is scoped per workspace, so it only ever touches repos you connected.",
    receipt: { href: "/dashboard/settings#github", label: "Connect GitHub" },
  },
  {
    title: "Channel workflow automation",
    body: "Message- or schedule-triggered workflows that post, request approval, or run steps in order, behind the same human-decision gate every other path in the product uses.",
  },
];

const IN_PROGRESS: Entry[] = [
  {
    title: "Rule health signals",
    body: "Usage and quality reporting for bound rules, shown only when runs carry real metadata and objective signals.",
  },
  {
    title: "First-run onboarding",
    body: "Every empty screen teaches the same one command, so the path from zero to a sealed record takes minutes without a doc-dive.",
  },
];

const PLANNED: Entry[] = [
  {
    title: "Team workspaces",
    body: "Shared workspaces with SSO and an audit log, so evidence and rules are governed the same way the code is.",
  },
  {
    title: "CI gate & PR checks",
    body: "Block a merge when the run that produced it violated the rules it was bound to. The chain of custody meets the pipeline.",
  },
  {
    title: "More trace providers",
    body: "Broader ingestion across agent CLIs and observability formats, so any run can become a record.",
  },
  {
    title: "Hosted API & SDK",
    body: "Programmatic sealing and rules fetch for custom agents: the same custody loop, callable from your own harness.",
  },
  {
    title: "OathExchange",
    body: "A directory for comparing agents by record-backed run history and workspace fit.",
  },
  {
    title: "OathLedger",
    body: "A repo timeline for sealed sessions, approved evidence, and bound workspace rules.",
  },
  {
    title: "OathGuard",
    body: "A policy-routing concept for carrying approved repo rules into agent starts.",
  },
];

const SECTIONS: Array<{
  key: string;
  no: string;
  eyebrow: string;
  status: "shipped" | "now" | "planned";
  heading: string;
  sub: string;
  entries: Entry[];
}> = [
  {
    key: "shipped",
    no: "01",
    eyebrow: "Shipped, live today",
    status: "shipped",
    heading: "What already holds up in court.",
    sub: "Every line below links to the real thing. No mockups, no waitlists.",
    entries: SHIPPED,
  },
  {
    key: "now",
    no: "02",
    eyebrow: "In progress",
    status: "now",
    heading: "On the bench right now.",
    sub: "Actively being built. Close enough to name, still too early to link.",
    entries: IN_PROGRESS,
  },
  {
    key: "next",
    no: "03",
    eyebrow: "Planned",
    status: "planned",
    heading: "Next in the chain.",
    sub: "Committed direction, honest about sequence, with no dates we'd have to walk back.",
    entries: PLANNED,
  },
];

/** Ranged defense-style section header (01 // LABEL). */
function Range({ no, label }: { no: string; label: string }) {
  return (
    <div className="lp-range">
      <span className="lp-range-no">{no}</span>
      <span className="lp-range-bar" aria-hidden />
      {label}
    </div>
  );
}

export default function RoadmapPage() {
  return (
    <div className="lp lp-page">
      <ScrollReveal />
      <div className="lp-atmos" aria-hidden />
      <Nav />
      <main className="lp-page-main lp-page-main--wide">
        <header className="lp-page-head">
          <div className="lp-ph-eyebrow lp-ph-eyebrow--steel">
            <span className="lp-tick" aria-hidden />
            Roadmap
          </div>
          <h1 className="lp-h-page">What&apos;s real, what&apos;s next.</h1>
          <p className="lp-lede-page">
            A ledger of what&apos;s live in M9R today, what&apos;s being built, and what comes
            after, in the order it will actually happen.
          </p>
        </header>

        {/* Status telemetry */}
        <section className="lp-reveal" style={{ marginTop: 8 }}>
          <div className="lp-tele lp-tele-3col">
            <div className="lp-tele-cell">
              <div className="lp-tele-v"><span>{SHIPPED.length}</span></div>
              <div className="lp-tele-l">Shipped</div>
              <p className="lp-tele-note">Live today, linked to the real thing</p>
            </div>
            <div className="lp-tele-cell">
              <div className="lp-tele-v">{IN_PROGRESS.length}</div>
              <div className="lp-tele-l">In progress</div>
              <p className="lp-tele-note">On the bench, actively being built</p>
            </div>
            <div className="lp-tele-cell">
              <div className="lp-tele-v">{PLANNED.length}</div>
              <div className="lp-tele-l">Planned</div>
              <p className="lp-tele-note">Committed direction, honest sequence</p>
            </div>
          </div>
        </section>

        {SECTIONS.map((section) => (
          <section key={section.key} className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingBottom: 8 }}>
            <Range no={section.no} label={section.eyebrow} />
            <h2 className="lp-doc-h" style={{ marginTop: 14 }}>{section.heading}</h2>
            <p className="lp-doc-lede">{section.sub}</p>
            <ul className="lp-ledger">
              {section.entries.map((entry) => (
                <li key={entry.title} className="lp-ledger-item">
                  <span className={`lp-ledger-node ${section.status}`} aria-hidden />
                  <div className="lp-ledger-body">
                    <h3>{entry.title}</h3>
                    <p>{entry.body}</p>
                  </div>
                  {entry.receipt && (
                    <Link href={entry.receipt.href} className="lp-ledger-receipt">
                      {entry.receipt.label} →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingBottom: 96 }}>
          <div className="lp-cta-panel" style={{ marginInline: "auto", maxWidth: "52rem" }}>
            <div className="lp-ph-eyebrow" style={{ justifyContent: "center", marginBottom: 16 }}>
              <span className="lp-tick" aria-hidden />
              Hold us to it
            </div>
            <h2>The shipped column only grows.</h2>
            <p>
              Try what&apos;s live today. Connecting an agent takes minutes and doesn&apos;t need a
              signup.
            </p>
            <div className="lp-cta-row" style={{ marginTop: 28, justifyContent: "center" }}>
              <Link href="/agents" className="lp-btn lp-btn-primary">
                Connect your agent
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
