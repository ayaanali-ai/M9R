import type { Metadata } from "next";
import Link from "next/link";
import ReferencePage, { Panel } from "@/components/reference/ReferencePage";
import s from "@/components/reference/ReferenceHome.module.css";
import d from "@/components/reference/ReferencePage.module.css";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Support — M9R",
  description: "Contact M9R support and find the privacy notice.",
};

export default function SupportPage() {
  return (
    <ReferencePage title="Need a hand?" intro="For account, product, or privacy questions, reach the M9R team directly.">
      <Panel title="Contact" heading="Email us." status={CONTACT_EMAIL}>
        <p>Email <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>. Include the page or workflow you were using and what went wrong; never send passwords, access tokens, or other secrets.</p>
        <div className={d.links}><a className={s.productButton} href={CONTACT_MAILTO}>Email support</a></div>
      </Panel>
      <Panel title="Privacy" heading="Your data." status="Privacy notice">
        <p>For information about data handled by the M9R website and service, read the M9R privacy notice.</p>
        <div className={d.links}><Link className={s.productLink} href="/privacy">Read the privacy notice</Link><Link className={s.productLink} href="/faq">Read the FAQ</Link></div>
      </Panel>
    </ReferencePage>
  );
}
