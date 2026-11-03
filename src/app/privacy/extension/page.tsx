import type { Metadata } from "next";
import Link from "next/link";
import ReferencePage from "@/components/reference/ReferencePage";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Retired browser extension — M9R",
  description: "The former M9R browser extension route is retired.",
};

export default function RetiredExtensionPage() {
  return (
    <ReferencePage
      title={<>Browser extension<br />retired.</>}
      intro="M9R no longer ships or requires a browser extension."
    >
      <section>
        <h2>Native desktop runtime</h2>
        <p>
          Browser and desktop work now runs through M9R&apos;s broker-owned native
          desktop runtime. It observes and controls the exact owner-visible
          browser window and other applications without Developer mode,
          unpacked extension folders, or a second browser profile.
        </p>
        <p>
          For setup, use <code>npx m9r-cli connect</code>, then{" "}
          <code>npx m9r-cli web setup --broker-only</code>. See the{" "}
          <Link href="/docs/get-started">getting-started guide</Link> for the
          supported path.
        </p>
      </section>
      <section>
        <h2>Questions</h2>
        <p>
          Questions about the retired route can be sent to{" "}
          <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>. The current data
          handling policy is in the <Link href="/privacy">M9R privacy policy</Link>.
        </p>
      </section>
    </ReferencePage>
  );
}
