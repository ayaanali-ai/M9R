import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ScrollReveal from "@/components/ScrollReveal";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Security — M9R",
  description: "M9R security posture, data handling, and current limitations.",
};

const live = [
  {
    title: "Redaction runs before storage, everywhere",
    desc: "Evidence submissions, run activity, PR/commit content, and workspace rules all pass through the same redaction path before they're written. It always runs.",
  },
  {
    title: "Secret redaction (CLI + server)",
    desc: "Common secret patterns are scanned and redacted: OpenAI keys, Anthropic keys, Stripe keys, AWS keys, GitHub tokens, bearer tokens, JWTs, private keys, and common contact data. The local CLI additionally redacts your own connection token from anything it prints.",
  },
  {
    title: "Per-workspace GitHub installs",
    desc: "Git features (push, PR create, git-as-events) are scoped to each workspace's own GitHub App installation. A workspace's token can only ever touch repos it connected, enforced by GitHub itself.",
  },
  {
    title: "Treat agent-produced content as untrusted",
    desc: "Content agents produce (commit messages, PR bodies, run activity) is treated as data. It is not used as a system prompt and cannot invoke tools.",
  },
  {
    title: "Tamper-evident audit log",
    desc: "Sensitive review actions and controlled-run events are written to a hash-chained audit log, so a record can't be silently edited after the fact.",
  },
  {
    title: "Rate limiting on covered endpoints",
    desc: "Application-level rate limits apply to sensitive API routes. Edge firewall and bot controls are operated separately and may vary by deployment.",
  },
];

const planned = [
  "User-initiated deletion of uploaded runs",
  "Account deletion on request",
  "Broader bot protection on public endpoints",
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

export default function SecurityPage() {
  return (
    <div className="lp lp-page">
      <ScrollReveal />
      <div className="lp-atmos" aria-hidden />
      <Nav />
      <main className="lp-page-main lp-page-main--narrow">
        <header className="lp-page-head">
          <div className="lp-ph-eyebrow lp-ph-eyebrow--steel">
            <span className="lp-tick" aria-hidden />
            Security
          </div>
          <h1 className="lp-h-page">Security &amp; Data Handling</h1>
          <p className="lp-lede-page">
            M9R treats agent activity, evidence, and connection tokens as sensitive. Redaction
            runs before storage across the product, and the local CLI redacts secrets from anything
            it prints. Do not submit API keys, secrets, private keys, customer PII, PHI, payment
            data, or other regulated sensitive data through any channel or evidence submission.
          </p>
        </header>

        {/* Live today */}
        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingBottom: 8 }}>
          <Range no="01" label="Live today" />
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
            {live.map((item) => (
              <div key={item.title} className="lp-doc">
                <div className="lp-doc-title">
                  <span className="lp-dot" aria-hidden />
                  {item.title}
                </div>
                <p>{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Planned */}
        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingBottom: 8 }}>
          <Range no="02" label="Planned, not yet implemented" />
          <div className="lp-doc" style={{ marginTop: 22 }}>
            <ul className="lp-list lp-list--planned">
              {planned.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* Do not submit */}
        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingTop: 0, paddingBottom: 8 }}>
          <div className="lp-warn">
            <h2>Do not submit</h2>
            <p>
              API keys, secrets, private keys, customer PII, PHI, payment data, or regulated
              sensitive data, in messages, evidence submissions, or any other channel.
            </p>
          </div>
        </section>

        {/* Compliance disclaimer + contact */}
        <section className="lp-doc-section lp-reveal" style={{ borderTop: 0, paddingTop: 0, paddingBottom: 96 }}>
          <div className="lp-legalese" style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--lp-muted)" }}>
            <p>
              M9R does not claim SOC 2, HIPAA, GDPR, or enterprise compliance. The product is
              early. We will only add a security claim here once it is implemented and verifiable.
            </p>
            <p style={{ marginTop: 10 }}>
              Contact:{" "}
              <a href={CONTACT_MAILTO} style={{ color: "var(--lp-oxblood-lit)" }}>
                {CONTACT_EMAIL}
              </a>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

