import type { Metadata } from "next";
import Link from "next/link";
import { WorldPage } from "@/components/world/WorldShell";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";
export const metadata: Metadata = { title: "Cookies and storage — M9R", description: "Necessary authentication storage and browser preferences in M9R." };
export default function Cookies() {
  return <WorldPage label="PRIVACY / BROWSER STORAGE" title="The small files." intro="This notice explains necessary browser storage. Read it alongside the Privacy Policy."><section><h2>Authentication and preferences</h2><p>M9R uses cookies and browser storage to maintain authentication, protect account flows, and remember settings such as your display theme. Authentication is handled by the existing Supabase integration. Clearing site data also removes saved browser preferences.</p></section><section><h2>Your choices</h2><p>You can inspect or delete this site’s cookies and storage in your browser settings. Blocking necessary storage may prevent sign-in or saved preferences from working. This website redesign does not add advertising trackers or optional analytics.</p><p>Future optional analytics or marketing storage needs a separate assessment and applicable consent before activation.</p></section><section><h2>Questions</h2><p>Contact <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a> or read the <Link href="/privacy">Privacy Policy</Link>. This notice is not a representation that the legal documents have received legal review.</p></section></WorldPage>;
}
