import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Acceptable Use Policy — M9R",
  description:
    "What you may and may not submit to M9R, the activities we prohibit, and how we enforce this policy.",
};

export default function AcceptableUsePage() {
  return (
    <div className="lp lp-page">
      <div className="lp-atmos" aria-hidden />
      <Nav />
      <main className="lp-page-main lp-page-main--narrow">
        <header className="lp-page-head">
          <div className="lp-ph-eyebrow lp-ph-eyebrow--steel">
            <span className="lp-tick" aria-hidden />
            Legal record
          </div>
          <h1 className="lp-h-page">Acceptable use policy</h1>
          <p className="lp-updated">Last updated · June 2026</p>
        </header>

        <div className="lp-letter" style={{ paddingBottom: 72 }}>
          <section className="lp-clause">
            <div className="lp-clause-no">§ 01</div>
            <h2>Prohibited content</h2>
            <p>You must not upload or submit to M9R:</p>
            <ul className="lp-list">
              <li>Data you do not have the legal right to process</li>
              <li>Secrets, private keys, passwords, or authentication tokens</li>
              <li>Payment card data or financial account numbers</li>
              <li>Protected health information (PHI)</li>
              <li>Government IDs, passports, driver&apos;s licenses</li>
              <li>Highly sensitive personal data as defined under applicable law</li>
              <li>Malware, executable payloads, or scripts intended to harm systems</li>
            </ul>
          </section>

          <section className="lp-clause">
            <div className="lp-clause-no">§ 02</div>
            <h2>Prohibited activities</h2>
            <p>You must not use M9R to:</p>
            <ul className="lp-list">
              <li>Attack, reverse engineer, exfiltrate, or abuse third-party systems</li>
              <li>Attempt to bypass rate limits, security controls, or access restrictions</li>
              <li>Upload malware or executable payloads</li>
              <li>Engage in any illegal activity</li>
              <li>Violate the rights of others</li>
            </ul>
          </section>

          <section className="lp-clause">
            <div className="lp-clause-no">§ 03</div>
            <h2>Enforcement</h2>
            <p>
              We reserve the right to review, reject, delete, or refuse analysis of any content that
              violates this policy. Repeated or severe violations may result in account suspension or
              termination without notice.
            </p>
          </section>

          <section className="lp-clause">
            <div className="lp-clause-no">§ 04</div>
            <h2>Provider names and marks</h2>
            <p>
              M9R may display provider names and marks solely to identify compatible agent
              connections and the execution origin reported for a run. Those references do not
              imply sponsorship, endorsement, certification, or partnership. Connected providers
              execute in their own environments and remain subject to their respective terms.
            </p>
          </section>

          <section className="lp-clause">
            <div className="lp-clause-no">§ 05</div>
            <h2>Reporting violations</h2>
            <p>
              If you believe someone is violating this policy, contact{" "}
              <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>.
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
