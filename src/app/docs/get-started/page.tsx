import type { Metadata } from "next";
import Link from "next/link";
import Guide from "@/components/world/Guide";
import { WorldPage } from "@/components/world/WorldShell";
import { SOURCE_URL } from "@/lib/marketing-content";

export const metadata: Metadata = {
  title: "Get started — M9R docs",
  description: "Connect your agents and shared browser with two commands.",
};

export default function GetStarted() {
  return (
    <WorldPage
      label="DOCS / GET STARTED"
      title="Make the connection."
      intro="Use the supported two-command path first. The source-checkout broker and standalone engine are optional troubleshooting or development paths."
    >
      <section id="quick-start">
        <h2>Quick start</h2>
        <p>Install Node.js 18 or newer, keep the provider apps you want signed in, then run these commands from any terminal:</p>
        <pre><code>{"npx m9r-cli connect\nnpx m9r-cli web setup\nnpx m9r-cli doctor"}</code></pre>
        <p>
          <code>connect</code> finds Claude Code, Codex, and OpenCode and opens
          one browser approval. <code>web setup</code> installs the managed
          browser extension and local broker. <code>doctor</code> confirms the
          connection.
        </p>
        <p>
          The only manual browser step is loading the copied
          <code>%LOCALAPPDATA%\M9R\extension</code> folder with Developer mode
          enabled. Use that same folder after updates; do not load a second
          repository copy.
        </p>
      </section>

      <section id="requirements">
        <h2>What you need</h2>
        <p>Node.js 18 or newer, a terminal, Chrome or Edge for browser work, and the provider apps you intend to connect.</p>
        <p>
          <a href={`${SOURCE_URL}/tree/main/cli`}>CLI source and requirements ↗</a>{" "}
          · <Link href="/auth?mode=signup">Create an account</Link> for hosted
          connections.
        </p>
      </section>

      <Guide />

      <section id="standalone-engine">
        <h2>Optional standalone engine</h2>
        <p>
          The self-contained Windows engine is a separate distribution and is
          not required for the supported browser setup. Use it only when a
          versioned release is published from the
          <a href="https://github.com/ayaanali-ai/M9R/releases?q=m9r-engine"> M9R engine releases ↗</a>.
          Verify the adjacent SHA-256 file before running its installer. Do not
          pipe downloaded code directly into PowerShell.
        </p>
      </section>

      <section id="troubleshooting">
        <h2>If something isn’t connecting.</h2>
        <details>
          <summary>Command not found</summary>
          <p>Use the commands exactly as shown: <code>npx m9r-cli ...</code>. Check that Node.js 18 or newer and npm are installed, then open a new terminal.</p>
        </details>
        <details>
          <summary>The browser extension is missing</summary>
          <p>Run <code>npx m9r-cli web setup</code>, load the copied managed folder in <code>chrome://extensions</code> or <code>edge://extensions</code>, and reload that same folder after an update.</p>
        </details>
        <details>
          <summary>An agent is missing</summary>
          <p>Install the provider CLI, sign in to its own app, and run <code>npx m9r-cli connect</code> again. M9R does not sign in to providers for you.</p>
        </details>
        <details>
          <summary>The connection looks offline</summary>
          <p>Run <code>npx m9r-cli doctor</code>. If it reports that no connection exists, run <code>npx m9r-cli connect</code> again and approve the browser request.</p>
        </details>
        <details>
          <summary>I want to undo this</summary>
          <p>Run <code>npx m9r-cli web uninstall</code> to remove the managed browser setup, or <code>npx m9r-cli disconnect</code> to revoke the hosted connection and remove its local token.</p>
        </details>
      </section>
    </WorldPage>
  );
}
