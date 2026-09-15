"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import HomeAuthModal, { type AuthModalSize } from "./HomeAuthModal";
import MonopoField from "./MonopoField";
import styles from "./MonopoHome.module.css";

const chapters = [
  ["Connect", "Keep your tools.", "Claude Code, Codex, OpenCode. The CLIs you already use, connected to the same workspace."],
  ["Remember", "Carry it forward.", "Search archived sessions across your connected agents. Pick up the work without repeating the brief."],
  ["Handoff", "Change minds. Not context.", "Send work to another connected agent with the context it needs to continue."],
  ["Review", "You make the call.", "Review the evidence your agents prepare. Decide what becomes part of the accepted record."],
];
function Terminal() {
  const [os, setOs] = useState("macOS");
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText("npx m9r-cli connect"); setStatus("Copied"); }
    catch { setStatus("Select the command to copy it manually."); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 2500);
  }
  return <div className={styles.terminal} id="install">
    <p>Install via terminal</p>
    <div className={styles.osTabs} aria-label="Operating system">{["macOS", "Linux", "Windows"].map(name => <button key={name} type="button" aria-pressed={os === name} onClick={() => setOs(name)}>{name === "macOS" ? "⌘" : name === "Windows" ? "⊞" : "›_"} {name}</button>)}</div>
    <div className={styles.command}><code>npx m9r-cli connect</code><button type="button" onClick={copy} aria-label="Copy install command">{status === "Copied" ? "✓" : "⧉"}</button></div>
    <p className={styles.note} aria-live="polite">{status || `Run in your project · ${os === "Windows" ? "PowerShell" : "Terminal"} · Node.js required`}</p>
  </div>;
}
export default function MonopoHome({ configured }: { configured: boolean }) {
  const [panel, setPanel] = useState<AuthModalSize | null>(null);
  const lens = useRef<HTMLDivElement>(null);
  const translated = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (lens.current) lens.current.style.transform = `translate3d(${event.clientX - 110}px,${event.clientY - 110}px,0)`;
      if (translated.current) { const box = translated.current.getBoundingClientRect(); translated.current.style.clipPath = `circle(110px at ${event.clientX - box.left}px ${event.clientY - box.top}px)`; }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return <div className={styles.home}>
    <MonopoField />
    <a href="#content" className={styles.skip}>Skip to content</a>
    <header className={styles.header}><nav className={styles.nav} aria-label="Main navigation">
      <a href="/memo">Memo</a><a href="#work">Explore</a><a href="https://github.com/ayaanali-ai/M9R#readme">Docs</a>
      <a href="#content" className={styles.logo} aria-label="M9R homepage">m9r ↗</a>
      <a href="https://github.com/ayaanali-ai/M9R">GitHub ↗</a><a href="/pricing">Pricing</a><a href="#install">Connect ↙</a>
    </nav></header>
    <main id="content">
      <section className={styles.hero}>
        <div className={styles.headline}><h1><span>Stop making</span><span>your agents</span><span>work alone.</span></h1><div ref={translated} className={styles.translated} lang="ja" aria-hidden="true"><span>エージェントを</span><span>ひとりで</span><span>働かせない。</span></div>
          <div className={styles.actions}><button onClick={() => setPanel("wide")}>Start for free ↗</button><button onClick={() => setPanel("compact")}>Sign in →</button></div>
          <Terminal />
        </div>
        <div className={styles.aside}><p>Different minds.<br />Something in common.</p><span>Claude Code / Codex / OpenCode</span></div>
        <a href="#work" className={styles.scroll}>Scroll to meet in the middle <span>↓</span></a>
      </section>
      <section id="work" aria-label="Explore M9R">{chapters.map(([label, title, body], index) => <article className={styles.chapter} key={label}>
        <div className={styles.chapterInner}><span className={styles.index}>0{index + 1} / {label}</span><h2>{title}</h2><div className={styles.chapterFoot}><span>0{index + 1} — 04</span><p>{body}</p><a href="#install" aria-label={`Connect your agents: ${label}`}>↗</a></div></div>
      </article>)}</section>
    </main>
    <footer className={styles.finale}>
      <div className={styles.finaleArt}><Image src="/guardian-finale.png" alt="" fill sizes="100vw" /></div>
      <div className={styles.endContent}><div className={styles.endGrid}>
        <div className={styles.endBrand}><a href="#content" className={styles.endSeal}>m9r ↗</a><p>Independent agents.<br />Shared context.</p><a href="/memo">Read the memo ↗</a></div>
        <div><span>Product</span><h3>Workspace</h3><a href="#work">Explore</a><a href="#install">Via terminal</a><a href="/pricing">Pricing</a></div>
        <div><span>Agents</span><h3>Your tools</h3><a href="#install">Claude Code</a><a href="#install">Codex</a><a href="#install">OpenCode</a></div>
        <div><span>Resources</span><h3>Open core</h3><a href="https://github.com/ayaanali-ai/M9R#readme">Documentation ↗</a><a href="https://github.com/ayaanali-ai/M9R">GitHub ↗</a><a href="/memo">Our memo</a></div>
        <div><span>Platform</span><h3>M9R</h3><button onClick={() => setPanel("wide")}>Create account</button><button onClick={() => setPanel("compact")}>Sign in</button><a href="/pricing">Plans</a></div>
      </div><div className={styles.endLegal}><span>© {new Date().getFullYear()} M9R</span><a href="https://github.com/ayaanali-ai/M9R">Open core ↗</a><div><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></div><a href="#content">Back to top ↑</a></div></div>
    </footer>
    <div ref={lens} className={styles.lens} aria-hidden="true" />
    {panel && <HomeAuthModal size={panel} configured={configured} onClose={() => setPanel(null)} />}
  </div>;
}
