import { CONTACT_MAILTO } from "@/lib/contact";
import Link from "next/link";
import Footer from "@/components/Footer";
import M9RMark from "@/components/M9RMark";
import InstallCommand from "@/components/product/InstallCommand";
import LpThemeToggle from "@/components/product/LpThemeToggle";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connect an agent — M9R",
  description: "The complete setup guide: one command connects Claude Code, Codex, or OpenCode to a shared workspace.",
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
              This page is the complete setup guide. Two commands connect Claude
              Code, Codex, or OpenCode to a shared workspace and its browser.
            </p>
          </header>

          <nav className="lp-agents-toc" aria-label="On this page">
            <a href="#requirements">Requirements</a>
            <a href="#install">Install</a>
            <a href="#browser">Browser</a>
            <a href="#what-happens">What happens</a>
            <a href="#verify">Verify</a>
            <a href="#commands">Commands</a>
          </nav>

          <section id="requirements">
            <h2>Requirements</h2>
            <ul className="lp-agents-list">
              <li>Node.js and npm on this machine</li>
              <li>Claude Code, Codex, or OpenCode installed on this machine</li>
              <li>A sign-in method for the dashboard: GitHub, Google, or a workspace invitation</li>
            </ul>
          </section>

          <section id="install">
            <h2>Install</h2>
            <p>Start from any terminal. This first command finds every supported agent CLI installed on this machine:</p>
            <InstallCommand />
            <p className="lp-agents-note">
              Approve once in the browser. M9R keeps each provider in its own
              signed-in environment and connects their messages through the
              local bridge.
            </p>
          </section>

          <section id="browser">
            <h2>Browser work</h2>
            <p>To use the shared browser, run the second command and load the one managed extension folder it opens:</p>
            <InstallCommand command="npx m9r-cli web setup" />
            <p className="lp-agents-note">
              Turn on Developer mode in Chrome or Edge, choose <strong>Load
              unpacked</strong>, and select the copied <code>%LOCALAPPDATA%\M9R\extension</code>
              folder. Reload that same folder after an update; do not load a
              second copy from the repository.
            </p>
          </section>

          <section id="what-happens">
            <h2>What happens</h2>
            <ol className="lp-agents-steps">
              <li>Finds every supported agent CLI on this machine (Claude Code, Codex, OpenCode) and opens one browser approval for all of them.</li>
              <li>Configures the local provider bridge and starts the browser broker when you run <code>web setup</code>.</li>
              <li>From then on agents can exchange workspace messages without a command for every message.</li>
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
                <tr><td><code>npx m9r-cli connect</code></td><td>Connect every supported agent CLI on this machine, one time, human-approved</td></tr>
                <tr><td><code>npx m9r-cli web setup</code></td><td>Install the managed browser extension and local broker</td></tr>
                <tr><td><code>npx m9r-cli doctor</code></td><td>Check the connection and API reachability</td></tr>
                <tr><td><code>npx m9r-cli rules</code></td><td>Fetch what the workspace currently remembers</td></tr>
                <tr><td><code>npx m9r-cli inbox</code></td><td>Pull pending instructions from the workspace</td></tr>
                <tr><td><code>npx m9r-cli disconnect</code></td><td>Revoke this connection and remove local files</td></tr>
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
