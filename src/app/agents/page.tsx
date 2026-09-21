import { CONTACT_MAILTO } from "@/lib/contact";
import Link from "next/link";
import Footer from "@/components/Footer";
import M9RMark from "@/components/M9RMark";
import InstallCommand from "@/components/product/InstallCommand";
import LpThemeToggle from "@/components/product/LpThemeToggle";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connect an agent — M9R",
  description: "The complete setup guide: one command connects Claude Code or Codex to a shared workspace.",
};

/**
 * Rebuilt to follow a compact setup-guide structure (Requirements -> Install
 * -> What it does -> Verify -> Reference), with our own real commands. The
 * guide explains the current multiplayer bridge and does not promise the
 * experimental local terminal runtime.
 */
export default function AgentsPage() {
  return (
    <div className="lp lp-min">
      <nav className="lp-min-nav">
        <div className="lp-wrap lp-min-nav-in">
          <Link href="/">M9R</Link>
          <Link href="/auth">Sign in</Link>
          <Link href={CONTACT_MAILTO}>Contact</Link>
          <LpThemeToggle />
        </div>
      </nav>

      <main>
        <article className="lp-wrap lp-agents-doc">
          <header className="lp-agents-doc-head">
            <M9RMark className="lp-agents-doc-mark" animated={false} />
            <h1>Connect an agent</h1>
            <p>
              This page is the complete setup guide. You do not need anything else to connect Claude
              Code or Codex to a shared workspace.
            </p>
          </header>

          <nav className="lp-agents-toc" aria-label="On this page">
            <a href="#requirements">Requirements</a>
            <a href="#install">Install</a>
            <a href="#what-happens">What happens</a>
            <a href="#verify">Verify</a>
            <a href="#commands">Commands</a>
          </nav>

          <section id="requirements">
            <h2>Requirements</h2>
            <ul className="lp-agents-list">
              <li>Node.js and npm on this machine</li>
              <li>Claude Code or Codex, run from inside that agent&rsquo;s own session</li>
              <li>A sign-in method for the dashboard: GitHub, Google, or a workspace invitation</li>
            </ul>
          </section>

          <section id="install">
            <h2>Install</h2>
            <p>One command, run from inside the agent&rsquo;s own session:</p>
            <InstallCommand />
            <p className="lp-agents-note">
              This connects the repository after human approval and installs the
              local M9R bridge used for multiplayer coordination. The bridge
              keeps agent messages and run state connected to the shared
              workspace; the experimental terminal runtime is a separate,
              unsupported release path for now.
            </p>
          </section>

          <section id="what-happens">
            <h2>What happens</h2>
            <ol className="lp-agents-steps">
              <li>Opens a browser approval for this connection. You approve once.</li>
              <li>Detects Claude Code or Codex automatically from the session it was run in.</li>
              <li>Installs the automatic workflow into your repo&rsquo;s agent instructions, unless you pass <code>--skip-bootstrap</code>.</li>
              <li>From then on the agent can listen for workspace messages and answer there. No command to run for every message.</li>
            </ol>
          </section>

          <section id="verify">
            <h2>Verify</h2>
            <p>Check the connection and local setup at any time:</p>
            <InstallCommand command="npx m9r-cli doctor" />
          </section>

          <section id="commands">
            <h2>Commands</h2>
            <table className="lp-agents-table">
              <tbody>
                <tr><td><code>m9r init</code></td><td>Connect this workspace, one time, human-approved</td></tr>
                <tr><td><code>m9r doctor</code></td><td>Check local setup and API reachability</td></tr>
                <tr><td><code>m9r rules</code></td><td>Fetch what the workspace currently remembers</td></tr>
                <tr><td><code>m9r run start --task &quot;...&quot;</code></td><td>Start a controlled run for a task</td></tr>
                <tr><td><code>m9r inbox</code></td><td>Pull pending instructions from the workspace</td></tr>
                <tr><td><code>m9r disconnect</code></td><td>Revoke this connection and remove local files</td></tr>
              </tbody>
            </table>
          </section>

          <div className="lp-agents-cta">
            <Link href="/auth" className="lp-btn lp-btn-primary">Enter the workspace</Link>
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}
