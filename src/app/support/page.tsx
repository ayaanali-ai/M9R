import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";
import { WorldPage } from "@/components/world/WorldShell";

export const metadata: Metadata = {
  title: "Support — M9R",
  description: "Contact M9R support and find the privacy notice.",
};

export default function SupportPage() {
  return (
    <WorldPage label="M9R / SUPPORT" title="Need a hand?" intro="For account, product, or privacy questions, reach the M9R team directly.">
      <section>
        <h2>Contact</h2>
        <p>Email <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>. Include the page or workflow you were using and what went wrong; never send passwords, access tokens, or other secrets.</p>
      </section>
      <section>
        <h2>Privacy</h2>
        <p>For information about data handled by the M9R website and service, read the <Link href="/privacy">M9R privacy notice</Link>.</p>
      </section>
    </WorldPage>
  );
}
