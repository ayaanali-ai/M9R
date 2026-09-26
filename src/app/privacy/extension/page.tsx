import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Browser extension privacy — M9R",
  description: "What the M9R Web Presence browser extension handles, what it stores, and what it never does.",
};

// Keep in step with docs/EXTENSION_PRIVACY_POLICY.md, the source text for this page.
const sections = [
  ["What this extension does", "M9R Web Presence connects the pages you choose in your browser to the M9R app running on your own computer. The AI agents you run there (for example Claude Code, Codex or OpenCode) can then work on those pages together, in view: you see their cursors and short status messages, you can message them from a bar on the page, and anything consequential waits for your approval. The extension does not run an AI model, and it does nothing useful without the M9R app on your computer."],
  ["Information handled", "For the browser tasks you start, the extension may handle page URLs and origins (to enforce the sites you allowed), page text returned by a read you asked for (including ordinary visible fields when explicitly targeted), the requested action, its target, its result and any text you ask an agent to type, agent names, presence and short messages shown on the page, and the messages you type or dictate in the message bar. Targeted reads or typing on hidden fields, password fields and fields marked for payment cards or one-time codes are refused. These are targeted safeguards, not a guarantee that other page text is free of sensitive information. Do not run an agent on a page unless you are comfortable sharing what it reads with that agent."],
  ["Microphone and speech", "Holding Alt+M turns on your microphone, only for as long as you hold it. Speech is turned into text by Chrome's built-in speech recognition, which sends the audio to Google's speech service under Google's terms; M9R does not receive, record or keep the audio. The level bars shown while you talk are computed on your computer and are not stored or sent anywhere. The recognised words are placed in the message box and are sent to your agents only when you press Enter. You choose whether to turn the microphone on: the first time, Chrome asks on a page the extension opens for that purpose."],
  ["How information is used and shared", "The extension uses this information only to carry out the browser work you asked for and to show its on-page display. It sends messages to the M9R app on your computer over a loopback connection (ws://127.0.0.1:47821). The M9R app passes requested page results and task data to the agent sessions you selected; those agents and their providers process the information under their own accounts, terms and privacy policies. M9R shared workspaces may also receive information when you explicitly use a shared workflow. The extension does not send page data to any M9R server by itself, and contains no analytics, advertising or tracking code. The connection to the M9R app is not encrypted and never leaves your computer's loopback interface; do not use this setup on a shared or untrusted computer. Anything an agent, provider or shared workspace does with information afterwards follows that service's own terms."],
  ["Storage and retention", "The extension does not store page text, form values or browsing history. It keeps in Chrome's extension storage: a mapping of named tabs (cleared when Chrome restarts or the extension reloads), where you last placed the thread pill, whether the pill is open and which tab it shows, your motion preference, whether the all-sites question has been asked, which message previews you hid, and a short log of the last Alt+M and Alt+N key presses used for troubleshooting (no typed text; you can clear it from the extension's key-log page). Presence messages are held in memory for a few seconds. The M9R app and your agents may keep their own logs; see their settings and policies."],
  ["The M9R app and paid plans", "The extension is free. Optional paid plans exist for features that run on M9R's servers (shared workspaces and history), and are bought on m9r.dev, never inside the extension."],
  ["Your controls", "Site access is requested only when needed, for the site you choose. Chrome's grant covers the whole site; M9R also limits each approved grant by action, path and time. You can revoke a site in Chrome at any time, use Stop all browser actions in the extension, or remove the extension. Stopping cannot retract information already delivered to an agent or provider."],
  ["Permissions", "tabs finds and manages M9R's tabs and checks the current site; scripting injects the extension's own packaged code into sites you allowed; alarms keeps the connection to the M9R app alive; storage keeps the settings above. Required host access is limited to your own computer; access to ordinary sites is optional and requested at runtime. The extension exposes two of its own pages (the thread pill and the message bar) and its provider badges to web pages so they can be shown in a frame on the page; the frames are isolated from the page, so a website cannot read what you type in them. It does not request cookies, history, debugger or download permissions, and it loads no remote code."],
  ["Names and marks", "Claude, Codex, OpenCode and other agent names or marks shown belong to their owners. M9R is independent and is not affiliated with, endorsed by or sponsored by them; the names identify which agent is acting."],
  ["Changes", "We will update this notice, with a new date, if the extension's data handling changes."],
] as const;

export default function ExtensionPrivacyPage() {
  return (
    <div className="lp lp-page">
      <div className="lp-atmos" aria-hidden />
      <Nav />
      <main className="lp-page-main lp-page-main--narrow">
        <header className="lp-page-head">
          <div className="lp-ph-eyebrow lp-ph-eyebrow--steel"><span className="lp-tick" aria-hidden />Privacy record</div>
          <h1 className="lp-h-page">Browser extension privacy</h1>
          <p className="lp-updated">Effective · September 26, 2026</p>
        </header>
        <div className="lp-letter" style={{ paddingBottom: 72 }}>
          <section className="lp-clause">
            <div className="lp-clause-no">Contact</div>
            <h2>Questions</h2>
            <p>Privacy questions about the extension can be sent to <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>. The broader <a href="/privacy">M9R privacy policy</a> covers accounts and the website.</p>
          </section>
          {sections.map(([title, body], index) => (
            <section key={title} className="lp-clause">
              <div className="lp-clause-no">§ {String(index + 1).padStart(2, "0")}</div>
              <h2>{title}</h2>
              <p>{body}</p>
            </section>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
