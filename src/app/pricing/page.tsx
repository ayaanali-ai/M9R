import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import PricingPlans from "@/components/pricing/PricingPlans";
import ScrollReveal from "@/components/ScrollReveal";
import type { Metadata } from "next";
import { BILLING_ENABLED } from "@/lib/billing-config";

/**
 * Pricing — describes the actual current product (Watchfloor chat, the
 * tamper-evident audit log, workspace rules, channel workflows) instead of
 * an earlier trace-analyzer product's feature set
 * ("Blackbox Reports," in-browser-only analysis) this page used to describe.
 *
 * The interactive tiers + comparison live in <PricingPlans /> (client, for the
 * billing toggle). This server shell carries the metadata, the value strip,
 * an FAQ, and the closing CTA. Paid billing is opt-in while Stripe is being
 * repaired; the dashboard never sends a user to checkout in the default mode.
 */

export const metadata: Metadata = {
  title: "Pricing — M9R",
  description:
    "M9R is free while billing is paused. No card is required; team billing returns after Stripe is re-verified.",
};

const VALUE_PROPS = [
  {
    title: "Evidence with real provenance",
    body: "Evidence is labeled by where it came from: an observed fact, a provider's claim, an agent's claim, or a human decision. Nothing counts until a person accepts it.",
    icon: <IconGauge />,
  },
  {
    title: "Your workspace is yours",
    body: "Every workspace is isolated at the database layer. Source and secrets are redacted before any evidence is stored. The record describes behavior only.",
    icon: <IconLock />,
  },
  {
    title: "Works with agents you already use",
    body: "Top coding agents, including Claude Code, Codex, OpenCode, Grok, and other CLI-capable providers, connect with one command. No SDK rewrite, no new agent to adopt.",
    icon: <IconBolt />,
  },
];

const FAQ = [
  {
    q: "Is the Free tier actually free?",
    a: "Yes. Up to two workspaces, up to two connected agents, up to ten active rules, forever, no card. Paid tiers remove those limits.",
  },
  {
    q: "What does “proof-grade” mean?",
    a: "Every piece of evidence carries a provenance: observed fact, provider claim, agent claim, or human decision. Each one moves through a lifecycle that ends only when a person accepts it, so a guess is always labeled as a guess.",
  },
  {
    q: "Can I switch between monthly and annual?",
    a: "Anytime, from the Stripe billing portal linked in Settings. History is kept either direction.",
  },
  {
    q: "How is Team priced?",
    a: "Team is custom, based on seats and governance needs (SSO, moderation roster, data residency). Reach out and we’ll scope it with you directly.",
  },
];

/** Ranged defense-style section header (01 // LABEL). */
function Range({ no, label }: { no: string; label: string }) {
  return (
    <div className="lp-range" style={{ justifyContent: "center" }}>
      <span className="lp-range-no">{no}</span>
      <span className="lp-range-bar" aria-hidden />
      {label}
    </div>
  );
}

export default function PricingPage() {
  return (
    <div className="lp lp-page">
      <ScrollReveal />
      <div className="lp-atmos" aria-hidden />
      <Nav />
      <main className="lp-page-main lp-page-main--wide">
        {/* Header */}
        <header className="lp-page-head lp-page-head--center">
          <div className="lp-ph-eyebrow lp-ph-eyebrow--steel" style={{ justifyContent: "center" }}>
            <span className="lp-tick" aria-hidden />
            Pricing
          </div>
          <h1 className="lp-h-page">Pay for proof, priced for the team actually using it.</h1>
          <p className="lp-lede-page">
            {BILLING_ENABLED
              ? "Start free with no card. Upgrade only when you need unlimited scale or team-grade governance."
              : "M9R is currently open for individual use while Stripe is being repaired. No card or payment is required."}
          </p>
        </header>

        {/* Interactive tiers + comparison */}
        <PricingPlans billingEnabled={BILLING_ENABLED} />

        {/* Value strip */}
        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0 }}>
          <Range no="01" label="Why teams choose M9R" />
          <div
            className="lp-doc-grid lp-doc-grid--2"
            style={{ marginTop: 32, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" }}
          >
            {VALUE_PROPS.map((item) => (
              <div key={item.title} className="lp-value">
                <span className="lp-cico" aria-hidden>{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="lp-doc-section lp-reveal">
          <Range no="02" label="Questions, answered" />
          <div className="lp-faq" style={{ marginTop: 32, marginInline: "auto", maxWidth: "48rem" }}>
            {FAQ.map((item) => (
              <div key={item.q} className="lp-faq-item">
                <div className="lp-faq-q">{item.q}</div>
                <p className="lp-faq-a">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Closing CTA */}
        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingBottom: 96 }}>
          <div className="lp-cta-panel" style={{ marginInline: "auto", maxWidth: "52rem" }}>
            <div className="lp-ph-eyebrow" style={{ justifyContent: "center", marginBottom: 16 }}>
              <span className="lp-tick" aria-hidden />
              Get started
            </div>
            <h2>Turn your next run into evidence.</h2>
            <p>
              Connect an agent and open a workspace in minutes. No card. No setup.
              No commitment.
            </p>
            <div className="lp-cta-row" style={{ marginTop: 28, justifyContent: "center" }}>
              <Link href="/agents" className="lp-btn lp-btn-primary">
                Connect your first agent
              </Link>
              <Link href="/dashboard" className="lp-btn lp-btn-ghost">
                Enter the workspace
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

/* Value-strip icons — clean line work, no emoji. Color inherits from .lp-cico. */
function IconGauge() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 13a7 7 0 0 1 7-7M12 13l4-4M5 18a8 8 0 1 1 14 0" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
