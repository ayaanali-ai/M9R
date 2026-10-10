import type { Metadata } from "next";
import Link from "next/link";
import ReferencePage, { Panel } from "@/components/reference/ReferencePage";
import { LegalLinks } from "@/components/reference/LegalDocument";
import d from "@/components/reference/ReferencePage.module.css";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";
export const metadata: Metadata = { title: "Cookies and storage — M9R", description: "Necessary authentication storage and browser preferences in M9R." };
export default function Cookies() {
  return <ReferencePage title="The small files." intro="This notice explains necessary browser storage. Read it alongside the Privacy Policy.">
    <Panel title="Storage" heading="Authentication and preferences." status="Necessary storage only"><p>M9R uses cookies and browser storage to maintain authentication, protect account flows, and remember settings such as your display theme. Authentication is handled by the existing Supabase integration. Clearing site data also removes saved browser preferences.</p></Panel>
    <Panel title="Choices" heading="Your choices." status="No advertising trackers"><p>You can inspect or delete this site’s cookies and storage in your browser settings. Blocking necessary storage may prevent sign-in or saved preferences from working. M9R does not use advertising trackers or optional analytics. Stripe may set its own cookies on its hosted checkout and billing pages, under Stripe&apos;s policies.</p><p>Future optional analytics or marketing storage needs a separate assessment and applicable consent before activation.</p></Panel>
    <Panel title="Questions" heading="Questions." status={CONTACT_EMAIL} wide><p className={d.measure}>Contact <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a> or read the <Link href="/privacy">Privacy Policy</Link>. This notice is not a representation that the legal documents have received legal review.</p></Panel>
    <LegalLinks current="/cookies" />
  </ReferencePage>;
}
