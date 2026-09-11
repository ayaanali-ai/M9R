import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export default function DataProcessingPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 pt-28 pb-20">
        <div className="mb-10">
          <div className="flex items-center gap-2 text-xs text-muted font-mono mb-2">
            <span className="w-2 h-2 rounded-full bg-lime" />
            Legal
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3">Data Processing</h1>
        </div>

        <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-6 mb-8">
          <p className="text-sm text-muted leading-relaxed mb-4">
            Enterprise data processing terms are available on request. We are happy to discuss
            specific contractual requirements for data processing agreements, including standard
            contractual clauses and data protection provisions.
          </p>
          <p className="text-sm text-muted leading-relaxed">
            Do not submit regulated personal data until an applicable Data Processing Agreement
            has been signed. For data-processing questions or to request an agreement, contact{" "}
            <a href={CONTACT_MAILTO} className="text-lime hover:underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </div>

        <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-6">
          <h2 className="font-semibold text-sm mb-3">How we handle data today</h2>
          <ul className="space-y-3 text-sm text-muted">
            <li className="flex items-start gap-2">
              <span className="text-lime shrink-0 mt-0.5">—</span>
              <span>Account and workspace data is processed to provide controlled runs, evidence review, records, support, reliability, and security.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-lime shrink-0 mt-0.5">—</span>
              <span>We do not train models on evidence, run activity, or any other submitted content.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-lime shrink-0 mt-0.5">—</span>
              <span>
                Evidence and run content pass through regex-based secret redaction before storage. This is
                best-effort and not a guarantee — avoid including secrets in what you submit.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-lime shrink-0 mt-0.5">—</span>
              <span>Connections use HTTPS.</span>
            </li>
          </ul>
          <h3 className="font-semibold text-sm mt-6 mb-3">Current controls and limitations</h3>
          <ul className="space-y-2 text-sm text-muted">
            <li className="flex items-start gap-2"><span className="shrink-0">—</span><span>Settings provides a self-service workspace-data purge; limited records may remain where required for security, integrity, disputes, or law.</span></li>
            <li className="flex items-start gap-2"><span className="shrink-0">—</span><span>Sensitive review actions and controlled-run events create audit records.</span></li>
            <li className="flex items-start gap-2"><span className="shrink-0">—</span><span>Application rate limits protect covered endpoints. Edge firewall and bot controls are operated separately and may vary by deployment.</span></li>
            <li className="flex items-start gap-2"><span className="shrink-0">—</span><span>Redaction is best-effort. Users must avoid submitting secrets or regulated data and should redact before transmission.</span></li>
          </ul>
        </div>
      </main>
      <Footer />
    </div>
  );
}

