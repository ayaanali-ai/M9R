import type { Metadata } from "next";
import ReferencePage, { Panel } from "@/components/reference/ReferencePage";
import { LegalLinks } from "@/components/reference/LegalDocument";
import d from "@/components/reference/ReferencePage.module.css";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Security — M9R",
  description: "M9R security posture, data handling, and current limitations.",
};

const live = [
  {
    title: "Redaction runs before storage on the main record paths",
    desc: "Evidence submissions, run activity, PR/commit content, workspace rules, captured agent sessions, and shared memory notes pass through the same redaction path before they're written. Live workspace chat messages and file attachments are stored as sent and are not redacted today.",
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
  {
    title: "Workspace isolation in the database",
    desc: "Workspace tables use database row-level security, so a signed-in user's queries only return rows for workspaces they own or belong to.",
  },
  {
    title: "Provider API keys are stored encrypted",
    desc: "Model-provider API keys you add are stored in Supabase Vault through server-only functions and are never returned to the browser.",
  },
  {
    title: "Payments handled by Stripe",
    desc: "Checkout, card details, and the billing portal are hosted by Stripe. M9R stores subscription identifiers and status, not card numbers, and verifies the signature on every billing webhook.",
  },
  {
    title: "Guardrails on browser and desktop control",
    desc: "Agent control of your browser and computer runs locally, over a connection limited to your own machine. Site access is granted per site and limited by action, path, and time; agents' cursors and status are shown on screen; tasks that look risky wait for a person's approval; and there is a stop control. The extension refuses targeted reads or typing on password, payment-card, and one-time-code fields.",
  },
];

const planned = [
  "Self-service account deletion (today it is handled on request by email)",
  "Self-service deletion of runs, evidence, and conversation history",
  "Redaction for live workspace chat messages and attachments",
  "Broader bot protection on public endpoints",
];

const limits = [
  "Browser and desktop control acts with your own permissions. Risk checks are pattern-based heuristics, not a sandbox, and can miss a harmful action or let one through.",
  "Anything an agent reads or sees on your screen is sent to that agent's AI provider and handled under the provider's terms.",
  "The local connection between the browser extension and the M9R app is not encrypted. Do not run M9R's local components on shared or untrusted computers.",
];

export default function SecurityPage() {
  return (
    <ReferencePage title={<>Security &amp;<br />data handling</>} intro="M9R treats agent activity, evidence, and connection tokens as sensitive.">
      <Panel title="Overview" heading="Before you submit anything." status="Read before connecting agents" wide>
        <p className={d.measure}>
          Redaction runs before storage on the main record paths, and the local CLI redacts secrets from
          anything it prints. Do not submit API keys, secrets, private keys, customer PII, PHI, payment
          data, or other regulated sensitive data through any channel or evidence submission.
        </p>
      </Panel>

      <Panel title="Live today" heading="Live today." status={`${live.length} controls in place`} wide>
        <ul className={d.steps} style={{ marginTop: 20 }}>
          {live.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Planned" heading="Planned, not yet implemented." status="Not live yet">
        <ul className={d.list}>
          {planned.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Panel>

      <Panel title="Known limits" heading="Known limits." status="Heuristics, not a sandbox">
        <ul className={d.list}>
          {limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Panel>

      <Panel title="Warning" heading="Do not submit." status="One exception: provider API keys">
        <p>
          API keys, secrets, private keys, customer PII, PHI, payment data, or regulated
          sensitive data, in messages, evidence submissions, or any other channel. The one
          exception is a provider API key entered in M9R&apos;s dedicated credential settings.
        </p>
      </Panel>

      <Panel title="Compliance" heading="No compliance claims." status={CONTACT_EMAIL}>
        <p>
          M9R does not claim SOC 2, HIPAA, GDPR, or enterprise compliance. The product is
          early. We will only add a security claim here once it is implemented and verifiable.
        </p>
        <p>
          Contact: <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>
        </p>
      </Panel>

      <LegalLinks current="/security" />
    </ReferencePage>
  );
}
