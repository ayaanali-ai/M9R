import type { Metadata } from "next";
import Link from "next/link";
import ReferenceGuide from "@/components/reference/ReferenceGuide";
import ReferencePage, { Panel } from "@/components/reference/ReferencePage";
import s from "@/components/reference/ReferenceHome.module.css";
import d from "@/components/reference/ReferencePage.module.css";
import { SOURCE_URL } from "@/lib/marketing-content";

export const metadata: Metadata = {
  title: "Get started — M9R docs",
  description: "Connect your agents and shared browser with two commands.",
};

const TROUBLESHOOTING = [
  ["Command not found", <>Use the commands exactly as shown: <code>npx m9r-cli ...</code>. Check that Node.js 18 or newer and npm are installed, then open a new terminal.</>],
  ["The browser extension is missing", <>Run <code>npx m9r-cli web setup</code>, load the copied managed folder in <code>chrome://extensions</code> or <code>edge://extensions</code>, and reload that same folder after an update.</>],
  ["An agent is missing", <>Install the provider CLI, sign in to its own app, and run <code>npx m9r-cli connect</code> again. M9R does not sign in to providers for you.</>],
  ["The connection looks offline", <>Run <code>npx m9r-cli doctor</code>. If it reports that no connection exists, run <code>npx m9r-cli connect</code> again and approve the browser request.</>],
  ["I want to undo this", <>Run <code>npx m9r-cli web uninstall</code> to remove the managed browser setup, or <code>npx m9r-cli disconnect</code> to revoke the hosted connection and remove its local token.</>],
] as const;

export default function GetStarted() {
  return (
    <ReferencePage
      title={<>Make the<br />connection.</>}
      intro="Use the supported two-command path first. The source-checkout broker and standalone engine are optional."
    >
      <Panel id="quick-start" title="Quick start" heading="Quick start" status="Any terminal">
        <p>Install Node.js 18 or newer, keep the provider apps you want signed in, then run these commands from any terminal:</p>
        <code className={d.pre}>{"npx m9r-cli connect\nnpx m9r-cli web setup\nnpx m9r-cli doctor"}</code>
        <p className={d.small}><code>connect</code> finds Claude Code, Codex, and OpenCode and opens one browser approval. <code>web setup</code> installs the managed browser extension and local broker. <code>doctor</code> confirms the connection.</p>
        <p className={d.small}>The only manual browser step is loading the copied <code>%LOCALAPPDATA%\M9R\extension</code> folder with Developer mode enabled. Use that same folder after updates; do not load a second repository copy.</p>
      </Panel>

      <Panel id="requirements" title="Requirements" heading="What you need" status="Node.js 18+">
        <p>Node.js 18 or newer, a terminal, Chrome or Edge for browser work, and the provider apps you intend to connect.</p>
        <div className={d.links}><Link className={s.productButton} href="/auth?mode=signup">Create an account</Link><a className={s.productLink} href={`${SOURCE_URL}/tree/main/cli`}>CLI source and requirements</a></div>
      </Panel>

      <ReferenceGuide />

      <Panel wide id="standalone-engine" title="Engine" heading="Optional standalone engine" status="Not required">
        <p>The self-contained Windows engine is a separate distribution and is not required for the supported browser setup. Use it only when a versioned release is published from the <a href="https://github.com/ayaanali-ai/M9R/releases?q=m9r-engine">M9R engine releases</a>. Verify the adjacent SHA-256 file before running its installer. Do not pipe downloaded code directly into PowerShell.</p>
      </Panel>

      <Panel wide id="troubleshooting" title="Troubleshooting" heading="If something isn’t connecting." status={`${TROUBLESHOOTING.length} common fixes`}>
        <div className={d.faq}>{TROUBLESHOOTING.map(([question, answer]) => <details key={question}><summary>{question}<span className={d.mark} aria-hidden="true" /></summary><p>{answer}</p></details>)}</div>
      </Panel>
    </ReferencePage>
  );
}
