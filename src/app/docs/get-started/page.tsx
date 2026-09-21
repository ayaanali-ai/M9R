import type { Metadata } from "next";
import Link from "next/link";
import Guide from "@/components/world/Guide";
import { WorldPage } from "@/components/world/WorldShell";
import { SOURCE_URL } from "@/lib/marketing-content";
export const metadata: Metadata = { title: "Get started — M9R docs", description: "CLI installation, hosted connections, native preview, and troubleshooting." };
export default function GetStarted() {
  return <WorldPage label="DOCS / GET STARTED" title="Make the connection." intro="A practical guide, not a magic trick. Hosted connection and native local setup are separate paths; preview commands are labeled throughout.">
    <section><h2>What you need</h2><p>Node.js, a terminal, and the provider apps you intend to connect. The CLI package declares Node 18 or newer; use a currently supported Node release. Keep your provider accounts signed in.</p><p><a href={`${SOURCE_URL}/tree/main/cli`}>CLI source and requirements ↗</a> · <Link href="/auth?mode=signup">Create an account</Link> for hosted connections.</p></section>
    <Guide />
    <section id="troubleshooting"><h2>If something isn’t connecting.</h2>
      <details><summary>Command not found</summary><p>Use <code>m9r-cli</code>, not <code>m9r</code>. Check that Node and npm are installed and npm’s global executable directory is on your PATH. Open a new terminal after installation.</p></details>
      <details><summary>Unknown setup or uninstall command</summary><p>Those are native-preview commands in the source checkout. Your published package may not include them. Check <code>m9r-cli --help</code>; do not assume an update has shipped.</p></details>
      <details><summary>An agent is missing</summary><p>Check that its app is installed and logged in, then run <code>m9r-cli doctor</code>. Native setup currently installs Claude Code hooks only. It does not automatically make every provider reachable.</p></details>
      <details><summary>Hooks or tools aren’t loaded</summary><p>Start a new Claude Code session after setup. Where Codex hooks are separately installed, review them in <code>/hooks</code>. After configuring Claude Desktop tools, restart Desktop.</p></details>
      <details><summary>A task was queued but no reply arrived</summary><p>A queue entry is not a delivery receipt. Confirm the recipient has an installed integration and active session. Local preview tasks appear on the next prompt, not as guaranteed background execution.</p></details>
      <details><summary>I want to undo this</summary><p>Local preview setup uses <code>m9r-cli uninstall</code>. Hosted connections use <code>m9r-cli disconnect</code>. Do not add purge flags unless you intend to delete local M9R data.</p></details>
    </section>
  </WorldPage>;
}
