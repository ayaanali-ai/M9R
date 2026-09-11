"use client";

/**
 * PricingPlans — the interactive heart of the pricing page.
 *
 * A monthly/annual billing toggle drives the tier cards and the comparison
 * matrix below them. Everything is framed around what each tier *proves* —
 * M9R sells accountability, and Pro is priced per seat because the
 * product itself is a multi-user workspace (the Watchfloor), not a solo
 * tool — usage scales with how many people are actually in the room.
 *
 * Tiers reflect what's actually built: Watchfloor chat, agent runs (findings,
 * evidence chain, human-decision gate), the tamper-evident audit log,
 * workspace rules, persona packs, channel workflow automation, and
 * moderation — not the earlier trace-analyzer product's feature set.
 */

import Link from "next/link";
import { useState } from "react";

type Billing = "monthly" | "annual";

type Tier = {
  name: string;
  // Price is a function of billing cadence; Free/Custom ignore it.
  price: (b: Billing) => string;
  cadence?: (b: Billing) => string | undefined;
  note?: (b: Billing) => string | undefined;
  tagline: string;
  proof: string;
  cta: { label: string; href: string };
  featured?: boolean;
  badge?: string;
  features: string[];
};

const TIERS: Tier[] = [
  {
    name: "Free",
    price: () => "$0",
    cadence: () => "forever",
    tagline: "One workspace, a couple of connected agents, the full governance loop.",
    proof: "Proves what happened, human-reviewed, from day one.",
    cta: { label: "Connect your first agent", href: "/dashboard" },
    features: [
      "Up to 2 workspaces, up to 2 agent connections",
      "Full workspace chat + agent runs",
      "Evidence chain + Run Passport",
      "Up to 10 active workspace rules",
    ],
  },
  {
    name: "Pro",
    price: (b) => (b === "annual" ? "$11" : "$14"),
    cadence: () => "/ seat / month",
    note: (b) => (b === "annual" ? "$132 billed yearly per seat" : undefined),
    tagline: "Unlimited agents, unlimited history, the full automation toolkit.",
    proof: "Proves progress over time, across every seat.",
    cta: { label: "Start free, upgrade later", href: "/dashboard" },
    featured: true,
    badge: "Most popular",
    features: [
      "Everything in Free",
      "Unlimited agent connections",
      "Unlimited workspace rules",
      "Channel workflow automation",
      "Priority support",
    ],
  },
  {
    name: "Team",
    price: () => "Custom",
    tagline: "Shared workspaces, SSO, and full moderation and audit control.",
    proof: "Proves accountability across a whole team.",
    cta: { label: "Talk to us", href: "mailto:hello@m9r.dev" },
    features: [
      "Everything in Pro",
      "SSO / SAML",
      "Moderation roster & admin tools",
      "Data-residency options",
      "Dedicated onboarding",
    ],
  },
];

// Grouped comparison — only rows that change a buying decision.
const COMPARISON: { group: string; rows: { label: string; free: string; pro: string; team: string }[] }[] = [
  {
    group: "Evidence",
    rows: [
      { label: "Workspace rules", free: "Up to 10", pro: "Unlimited", team: "Unlimited" },
      { label: "Evidence chain + Run Passport", free: "✓", pro: "✓", team: "✓" },
      { label: "Git provenance signing", free: "✓", pro: "✓", team: "✓" },
    ],
  },
  {
    group: "Automation",
    rows: [
      { label: "Agent connections", free: "Up to 2", pro: "Unlimited", team: "Unlimited" },
      { label: "Channel workflow automation", free: "—", pro: "✓", team: "✓" },
    ],
  },
  {
    group: "Team & governance",
    rows: [
      { label: "Workspace seats", free: "1", pro: "Per seat", team: "Unlimited" },
      { label: "SSO / SAML", free: "—", pro: "—", team: "✓" },
      { label: "Moderation roster & admin tools", free: "—", pro: "—", team: "✓" },
      { label: "Data residency", free: "—", pro: "—", team: "✓" },
      { label: "Support", free: "Community", pro: "Priority", team: "Dedicated" },
    ],
  },
];

export default function PricingPlans({ billingEnabled }: { billingEnabled: boolean }) {
  const [billing, setBilling] = useState<Billing>("annual");
  const tiers = billingEnabled
    ? TIERS
    : TIERS.map((tier) => tier.name === "Free"
      ? {
          ...tier,
          tagline: "The complete individual workspace while billing is paused.",
          proof: "No card, no expiry, no paid gate.",
          features: [
            "Unlimited individual workspaces",
            "Unlimited connected agents",
            "Full workspace chat + agent runs",
            "Evidence chain + Run Passport",
            "Unlimited workspace rules while billing is paused",
          ],
        }
      : {
          ...tier,
          price: () => "Coming later",
          cadence: () => undefined,
          note: () => undefined,
          cta: { label: "Billing paused", href: "/pricing" },
          featured: false,
          badge: "Not accepting payment",
        });
  const comparison = billingEnabled
    ? COMPARISON
    : COMPARISON.map((section) => ({
        ...section,
        rows: section.rows.map((row) => {
          if (["Workspace rules", "Agent connections", "Workspace seats"].includes(row.label)) {
            return { ...row, free: "Open", pro: "Coming later", team: "Coming later" };
          }
          return row;
        }),
      }));

  return (
    <>
      {!billingEnabled && (
        <div className="lp-tier-proof" role="status" style={{ marginTop: 32, justifyContent: "center" }}>
          Billing is paused while Stripe is being repaired. Individual access is open; no payment is required.
        </div>
      )}
      {/* Billing toggle */}
      {billingEnabled && <div style={{ marginTop: 40, display: "flex", justifyContent: "center" }}>
        <div className="lp-toggle">
          {(["monthly", "annual"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBilling(b)}
              aria-pressed={billing === b}
            >
              {b === "monthly" ? "Monthly" : "Annual"}
              {b === "annual" && <span className="lp-save">−20%</span>}
            </button>
          ))}
        </div>
      </div>}

      {/* Tier cards */}
      <div
        style={{
          marginTop: 40,
          display: "grid",
          gap: 20,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
        }}
      >
        {tiers.map((tier) => {
          const cadence = tier.cadence?.(billing);
          const note = tier.note?.(billing);
          return (
            <article key={tier.name} className={`lp-tier${tier.featured ? " lp-tier--featured" : ""}`}>
              {tier.badge && <span className="lp-tier-badge">{tier.badge}</span>}

              <h2 className="lp-tier-name">{tier.name}</h2>

              <div className="lp-tier-price lp-price">
                <span className="lp-tier-amt">{tier.price(billing)}</span>
                {cadence && <span className="lp-tier-cad">{cadence}</span>}
              </div>
              <div className="lp-tier-note">{note ?? ""}</div>

              <p className="lp-tier-tag">{tier.tagline}</p>

              {/* What this tier proves — the differentiator. */}
              <div className="lp-tier-proof">
                <ShieldCheck />
                <span>{tier.proof}</span>
              </div>

              {billingEnabled || tier.name === "Free" ? (
                <Link
                  href={tier.name === "Free" && !billingEnabled ? "/auth" : tier.cta.href}
                  className={`lp-btn ${tier.featured ? "lp-btn-primary" : "lp-btn-ghost"}`}
                  style={{ marginTop: 22, width: "100%" }}
                >
                  {tier.cta.label}
                </Link>
              ) : (
                <span className="lp-btn lp-btn-ghost" aria-disabled="true" style={{ marginTop: 22, width: "100%", opacity: 0.6 }}>
                  {tier.cta.label}
                </span>
              )}

              <ul className="lp-tier-feats">
                {tier.features.map((feature) => (
                  <li key={feature}>
                    <Check />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>

      {/* Comparison matrix */}
      <section className="lp-doc-section" style={{ borderTop: 0, marginTop: 40 }}>
        <div style={{ textAlign: "center", maxWidth: "34rem", marginInline: "auto" }}>
          <h2 className="lp-doc-h" style={{ fontSize: 22 }}>Compare every plan</h2>
          <p className="lp-doc-lede" style={{ marginInline: "auto" }}>
            {billingEnabled
              ? "The Free tier is genuinely generous. Paid tiers add unlimited scale and team-grade governance."
              : "Individual access is open while billing is paused. Paid and team tiers return after Stripe is re-verified."}
          </p>
        </div>

        <div
          style={{
            marginInline: "auto",
            marginTop: 32,
            maxWidth: "56rem",
            overflow: "hidden",
            borderRadius: 6,
            border: "1px solid var(--lp-hair-strong)",
            overflowX: "auto",
          }}
        >
          <table className="lp-matrix">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Free</th>
                <th className="lp-col-pro">Pro</th>
                <th>Team</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((section) => (
                <FragmentGroup key={section.group} group={section.group} rows={section.rows} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function FragmentGroup({
  group,
  rows,
}: {
  group: string;
  rows: { label: string; free: string; pro: string; team: string }[];
}) {
  return (
    <>
      <tr className="lp-group">
        <td colSpan={4}>{group}</td>
      </tr>
      {rows.map((row) => (
        <tr key={row.label} className="lp-mrow">
          <td>{row.label}</td>
          <Cell value={row.free} />
          <Cell value={row.pro} highlight />
          <Cell value={row.team} />
        </tr>
      ))}
    </>
  );
}

function Cell({ value, highlight }: { value: string; highlight?: boolean }) {
  const isYes = value === "✓";
  const isNo = value === "—";
  return (
    <td className={highlight ? "lp-cell-pro" : undefined}>
      {isYes ? (
        <span className="lp-yes" style={{ display: "inline-flex" }}><Check /></span>
      ) : isNo ? (
        <span className="lp-no">&mdash;</span>
      ) : (
        <span>{value}</span>
      )}
    </td>
  );
}

/* Inline icons — line-weight, never emoji. Colors inherit from the .lp-* rules. */
function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="m2.5 7 3 3L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ShieldCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M7 1 2 3v3.5c0 3 1.8 5 5 6.5 3.2-1.5 5-3.5 5-6.5V3L7 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="m4.5 7 1.8 1.8L9.5 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
