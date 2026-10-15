import type { Metadata } from "next";
import ReferencePage from "@/components/reference/ReferencePage";
import { LegalDocument, LegalLinks } from "@/components/reference/LegalDocument";
import d from "@/components/reference/ReferencePage.module.css";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Acceptable Use Policy — M9R",
  description:
    "What you may and may not submit to M9R, the activities we prohibit, and how we enforce this policy.",
};

const sections = [
  {
    title: "Prohibited content",
    body: (
      <>
        <p>You must not upload or submit to M9R:</p>
        <ul className={d.list}>
          <li>Data you do not have the legal right to process</li>
          <li>
            Secrets, private keys, passwords, or authentication tokens (except provider API keys
            entered in M9R&apos;s dedicated credential settings)
          </li>
          <li>Payment card data or financial account numbers</li>
          <li>Protected health information (PHI)</li>
          <li>Government IDs, passports, driver&apos;s licenses</li>
          <li>Highly sensitive personal data as defined under applicable law</li>
          <li>Malware, executable payloads, or scripts intended to harm systems</li>
        </ul>
      </>
    ),
  },
  {
    title: "Prohibited activities",
    body: (
      <>
        <p>You must not use M9R to:</p>
        <ul className={d.list}>
          <li>Attack, reverse engineer, exfiltrate, or abuse third-party systems</li>
          <li>Attempt to bypass rate limits, security controls, or access restrictions</li>
          <li>Upload malware or executable payloads</li>
          <li>Send spam, run phishing or fraud, or impersonate people or organizations</li>
          <li>Harass, stalk, or surveil people, or collect their personal data without a lawful basis</li>
          <li>Engage in any illegal activity</li>
          <li>Violate the rights of others</li>
        </ul>
      </>
    ),
  },
  {
    title: "Browser and desktop control",
    body: (
      <>
        <p>
          Agents connected through M9R can click, type, read pages, and take screenshots in your
          browser and, with the desktop app, on your computer. You must not use these
          capabilities, or direct an agent to use them, to:
        </p>
        <ul className={d.list}>
          <li>
            Operate, monitor, or read from any computer, browser profile, or account you do not
            own or are not authorized to use, including another person&apos;s device without their
            informed permission
          </li>
          <li>
            Gain unauthorized access to systems or data, or bypass authentication, CAPTCHAs, bot
            detection, paywalls, rate limits, or other security or access controls
          </li>
          <li>
            Automate fraud, spam, fake accounts, fake reviews, vote or engagement manipulation, or
            purchases or transfers that the account holder has not authorized
          </li>
          <li>
            Scrape or bulk-collect content or personal data in violation of a site&apos;s terms,
            robots rules, or applicable law, or place abusive load on third-party services
          </li>
          <li>
            Capture or transmit passwords, payment details, one-time codes, or other people&apos;s
            private messages or records without authorization
          </li>
          <li>
            Hide agent activity from the person whose device or account is being operated, or
            disable the approval and stop controls to avoid oversight on a device you do not own
          </li>
        </ul>
        <p>
          You remain responsible for every action an agent takes through your computer, browser,
          or accounts, whether or not you approved it individually.
        </p>
      </>
    ),
  },
  {
    title: "Workspaces, guests, and other people's data",
    body: (
      <p>
        Only invite people and agents you trust into a workspace or room, and only share data
        you are allowed to share with them and with their AI providers. Do not use M9R to
        process other people&apos;s personal data, such as data handled by personal-assistant
        agents, unless you have a lawful basis to do so.
      </p>
    ),
  },
  {
    title: "Enforcement",
    body: (
      <p>
        We reserve the right to review, reject, delete, or refuse analysis of any content that
        violates this policy, and to suspend accounts or agent connections that we reasonably
        believe are being misused. Repeated or severe violations may result in
        account suspension or termination without notice.
      </p>
    ),
  },
  {
    title: "Provider names and marks",
    body: (
      <p>
        M9R may display provider names and marks solely to identify compatible agent
        connections and the execution origin reported for a run. Those references do not
        imply sponsorship, endorsement, certification, or partnership. Connected providers
        execute in their own environments and remain subject to their respective terms.
      </p>
    ),
  },
  {
    title: "Reporting violations",
    body: (
      <p>
        If you believe someone is violating this policy, contact{" "}
        <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>.
      </p>
    ),
  },
];

export default function AcceptableUsePage() {
  return (
    <ReferencePage title="Acceptable use" intro="What you may submit to M9R, what agents may never be used for, and how we enforce it.">
      <LegalDocument name="Acceptable use policy" effective="Last updated October 10, 2026" sections={sections} />
      <LegalLinks current="/acceptable-use" />
    </ReferencePage>
  );
}
