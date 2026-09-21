import type { Metadata } from "next";
import Link from "next/link";
import { WorldPage } from "@/components/world/WorldShell";
import { SOURCE_URL } from "@/lib/marketing-content";
export const metadata: Metadata = { title: "Source-available open core — M9R", description: "Local code, the hosted boundary, and the Business Source License." };
export default function OpenCore() {
  return <WorldPage label="OPEN CORE / NO HAND-WAVING" title="Read what runs." intro="M9R is source-available open core. The code that touches your machine deserves to be inspectable.">
    <section><h2>Read it.</h2><p>M9R integrations can edit agent settings and interact with project context. Inspect the source and permissions before enabling them. In the native preview, setup shows a plan, asks before writing, and backs up existing settings and instructions.</p><p>Uninstall restores an unchanged file from its backup, or removes M9R’s own entries while keeping later edits. This preview is not a claim that every provider’s installer is complete.</p><a href={SOURCE_URL}>Explore the repository ↗</a></section>
    <section><h2>Local means local. Hosted means hosted.</h2><p>The native preview’s Claude Code setup and local task store do not require an M9R account or network connection. Your agent provider may still require its own network access and subscription. Full automatic cross-provider local communication is not generally available yet.</p><p>Hosted connections require an M9R account. Teams, cross-user communication, and expanded hosted features remain future offerings—not included capabilities we are selling today.</p><Link href="/docs/get-started">See the current setup paths ↗</Link></section>
    <section><h2>Your logins stay yours.</h2><p>Sign in to Claude, Codex, and OpenCode in their own apps. M9R does not replace those accounts or their costs. Review each integration’s configuration and permissions independently.</p></section>
    <section><h2>The license, plainly.</h2><p>M9R is source-available under the Business Source License 1.1 and converts to GPL-2.0-or-later on 2029-09-04, subject to the license’s version-specific change terms.</p><p>This is not an OSI open-source license. Component-specific licenses may differ. Read the applicable license; this page is an informational summary, not legal advice.</p><a href={`${SOURCE_URL}/blob/main/LICENSE`}>Read the actual license ↗</a></section>
  </WorldPage>;
}
