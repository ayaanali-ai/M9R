import type { Metadata } from "next";
import ReferencePage, { Panel } from "@/components/reference/ReferencePage";
import { LegalLinks } from "@/components/reference/LegalDocument";
import s from "@/components/reference/ReferenceHome.module.css";
import d from "@/components/reference/ReferencePage.module.css";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Data Processing — M9R",
  description: "How M9R processes workspace data, the service providers it uses, and how AI-provider data flows work.",
};

// Revised 2026-10-10 as a draft-and-flag pass; not attorney-reviewed. Keep the provider list in step with real integrations.
const subprocessors = [
  ["Cloudflare", "Website and application hosting, network delivery, and the real-time relay that carries workspace messages and agent events."],
  ["Supabase", "Database, authentication, file storage for attachments, and encrypted storage for provider API keys."],
  ["Stripe", "Payment processing, subscriptions, trials, invoices, and the billing portal. Card details are collected by Stripe, not stored by M9R."],
  ["Resend", "Transactional email such as account confirmations, invitations, and notices."],
  ["GitHub", "Sign-in with GitHub and the GitHub App integration, only when you choose to use them."],
  ["Google", "Sign-in with Google, only when you choose to use it. Voice input in the browser extension uses Chrome's speech recognition under Google's terms."],
] as const;

export default function DataProcessingPage() {
  return (
    <ReferencePage title="Data processing" intro="How M9R processes workspace data, the providers it uses, and where AI-provider data goes.">
      <Panel title="Agreement" kicker="Last updated October 10, 2026" heading="Data Processing Agreement." status="Available on request" wide>
        <p className={d.measure}>
          A Data Processing Agreement for business customers is available on request. We are happy to
          discuss specific contractual requirements, including standard contractual clauses and data
          protection provisions.
        </p>
        <p className={d.measure}>
          Do not submit regulated personal data until an applicable Data Processing Agreement
          has been signed. For data-processing questions or to request an agreement, contact{" "}
          <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>.
        </p>
        <div className={d.links}><a className={s.productButton} href={CONTACT_MAILTO}>Request an agreement</a></div>
      </Panel>

      <Panel title="Service providers" heading="Service providers we use." status={`${subprocessors.length} service providers`} wide>
        <p className={d.measure}>
          These providers process data on M9R&apos;s behalf to run the service. We will update this list
          when it changes.
        </p>
        <ul className={d.steps} style={{ marginTop: 28 }}>
          {subprocessors.map(([name, purpose]) => (
            <li key={name}>
              <h3>{name}</h3>
              <p>{purpose}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="AI providers" heading="AI providers and the agents you connect." status="Provider terms apply">
        <ul className={d.list}>
          <li>
            Agents such as Claude Code (Anthropic), Codex (OpenAI), and OpenCode, and models from
            providers such as xAI or Google, run under your own or your teammates&apos; provider
            accounts. Content routed to an agent, including messages, files, page text, screenshots,
            and memory, goes to that agent&apos;s provider and is handled under the provider&apos;s terms,
            retention, and training settings.
          </li>
          <li>
            If you add a provider API key to M9R, M9R sends requests to that provider on your behalf
            with your key. The key is stored encrypted and is never shown back to the browser.
          </li>
          <li>
            In a shared workspace, other members&apos; agents can receive what you share there, so your
            content may reach providers you do not use yourself.
          </li>
          <li>
            Browser and desktop control run on your own computer. What agents read or see there goes
            to those agents and their providers, and reaches M9R&apos;s servers only when you use a shared
            room, workspace, or cross-machine session.
          </li>
        </ul>
      </Panel>

      <Panel title="Handling" heading="How we handle data today." status="Current controls and limitations">
        <ul className={d.list}>
          <li>Account, workspace, memory, and billing data is processed to provide workspaces, agent coordination, records, payments, support, reliability, and security.</li>
          <li>M9R does not train models on your messages, memory, evidence, run activity, or any other submitted content. AI providers you use apply their own training policies.</li>
          <li>
            Evidence, run activity, captured agent sessions, and shared memory notes pass through
            pattern-based secret redaction before storage. Live workspace chat messages and file
            attachments are stored as sent. Redaction is best-effort and not a guarantee, so avoid
            including secrets in what you submit.
          </li>
          <li>Connections to M9R&apos;s servers use HTTPS or secure WebSockets.</li>
        </ul>
        <h3 className={d.sub}>Current controls and limitations</h3>
        <ul className={d.list}>
          <li>Settings lets you export your workspaces, connected agents, runs, evidence, findings, and rules as JSON.</li>
          <li>Shared memory notes can be deleted individually. The Settings &ldquo;clear data&rdquo; control currently covers only legacy uploaded traces and rules; other deletion, including account deletion, is handled on request by email. Limited records may remain where required for security, integrity, disputes, or law.</li>
          <li>Sensitive review actions and controlled-run events create tamper-evident audit records.</li>
          <li>Application rate limits protect covered endpoints. Edge firewall and bot controls are operated separately and may vary by deployment.</li>
          <li>Redaction is best-effort. Users must avoid submitting secrets or regulated data and should redact before transmission.</li>
        </ul>
      </Panel>

      <LegalLinks current="/data-processing" />
    </ReferencePage>
  );
}
