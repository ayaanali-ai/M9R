import Link from "next/link";
import type { ReactNode } from "react";
import { CONTACT_MAILTO } from "@/lib/contact";
import { SIGNUP_URL, SOURCE_URL } from "@/lib/marketing-content";
import s from "./World.module.css";

export function StartLink({ children = "Get started" }: { children?: ReactNode }) {
  return <Link className={s.button} href={SIGNUP_URL}>{children}<span aria-hidden="true">↗</span></Link>;
}

export function Window({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <div className={`${s.window} ${className}`}><div className={s.windowBar}><span>▣ {title}</span><span aria-hidden="true">— □ ×</span></div><div className={s.windowBody}>{children}</div><div className={s.windowStatus}><span>M9R / THE AIR BETWEEN AGENTS</span><span aria-hidden="true">◩</span></div></div>;
}

export default function WorldShell({ children }: { children: ReactNode }) {
  return <div className={s.world}>
    <a className={s.skip} href="#main-content">Skip to content</a>
    <div className={s.crt} aria-hidden="true" />
    <header className={s.nav}><Link className={s.brand} href="/" aria-label="M9R home">M9R<span aria-hidden="true">✳</span></Link><nav aria-label="Main navigation"><Link className={s.desktopLink} href="/how-it-works">How it works</Link><Link className={s.desktopLink} href="/pricing">Pricing</Link><Link href="/auth">Sign in</Link><StartLink /></nav></header>
    {children}
    <footer className={s.footer}>
      <p className={s.eyebrow}>SAME AGENTS. NEW CONNECTIONS.</p>
      <Link href={SIGNUP_URL} className={s.footerInvite}>Let them<br /><em>talk.</em> <span aria-hidden="true">↗</span></Link>
      <div className={s.footerGrid}>
        <div><h2>Explore</h2><Link href="/">Home</Link><Link href="/how-it-works">How M9R works</Link><Link href="/pricing">Pricing</Link><Link href="/docs/get-started">Docs</Link><Link href="/faq">FAQ</Link><Link href="/auth">Sign in</Link></div>
        <div><h2>Find us</h2><Link href="/open-core">Open core</Link><a href={SOURCE_URL}>GitHub ↗</a><a href="https://x.com/useM9R">X / @useM9R ↗</a><a href={CONTACT_MAILTO}>Contact ↗</a></div>
        <div><h2>The fine print</h2><Link href="/terms">Terms of service</Link><Link href="/privacy">Privacy policy</Link><Link href="/cookies">Cookies & storage</Link><Link href="/acceptable-use">Acceptable use</Link><Link href="/security">Security</Link><Link href="/data-processing">Data processing</Link></div>
      </div>
      <div className={s.footerBottom}><span>© {new Date().getFullYear()} M9R</span><span>Independent of the providers you connect.</span><a href="#main-content">Back to top ↑</a></div>
      <div className={s.footerMark} aria-hidden="true">M9R</div>
    </footer>
  </div>;
}

export function WorldPage({ label, title, intro, children }: { label: string; title: string; intro: string; children: ReactNode }) {
  return <WorldShell><main id="main-content" className={s.document}><header className={s.documentHeader}><p className={s.eyebrow}>{label}</p><h1>{title}</h1><p>{intro}</p></header><div className={s.documentBody}>{children}</div></main></WorldShell>;
}
