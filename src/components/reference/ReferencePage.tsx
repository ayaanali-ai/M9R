"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import s from "./ReferenceHome.module.css";
import p from "./ReferencePricing.module.css";
import d from "./ReferencePage.module.css";

const asset = (name: string) => `/reference-innerwebs/${name}`;

/* Shell for secondary marketing pages: same backdrop, CRT frame, nav and footer as the homepage. */
export default function ReferencePage({ title, intro, children }: { title: ReactNode; intro: ReactNode; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const update = () => { frame = 0; el.style.setProperty("--nav-progress", String(Math.max(0, Math.min(1, window.scrollY / 240)))); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); };
  }, []);

  return <div className={`${s.study} ${p.page}`} ref={root}>
    <a href="#content" className={s.skip}>Skip to content</a>
    <div className={s.backdrop} aria-hidden="true" />
    <div className={s.scanlines} aria-hidden="true" />
    <div className={s.crtTop} aria-hidden="true"><img src={asset("29b917084067f0b0.webp")} alt="" /></div>
    <div className={s.crtBottom} aria-hidden="true"><img src={asset("9a18f35b2adad8d3.webp")} alt="" /></div>

    <header className={s.header}><nav className={s.nav} aria-label="Main"><Link href="/" aria-label="M9R home"><span className={s.logoText}>M9R</span></Link><div className={s.navActions}><Link className={s.reserve} href="/rooms/new">Open your room</Link><Link className={s.reserve} href="/auth?mode=login">Sign in</Link></div></nav></header>

    <main className={p.main}>
      <section className={p.intro} aria-labelledby="page-title">
        <h1 id="page-title">{title}</h1>
        <p>{intro}</p>
      </section>
      <div id="content" className={d.content}>{children}</div>
    </main>

    <footer className={s.footer}><div className={s.footerMarquee} aria-hidden="true">{[0, 1].map(copy => <div className={s.wordmarks} key={copy}><span className={s.wmSerif}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmItalic}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmPixel}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmBold}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /></div>)}</div><div className={s.footerInner}><nav aria-label="Footer"><Link href="/">Home</Link><Link href="/how-it-works">How it works</Link><Link href="/pricing">Pricing</Link><Link href="/docs">Docs</Link><Link href="/faq">FAQ</Link><Link href="/open-core">Open core</Link></nav><div className={s.socials}><a href="https://x.com/useM9R" target="_blank" rel="noreferrer" aria-label="X (@useM9R)"><img src={asset("7e2a52ba473849dc.webp")} alt="" /></a></div></div><p className={s.legal}>M9R © 2026 All rights reserved　𐄁　<Link href="/terms">Terms</Link>　𐄁　<Link href="/privacy">Privacy</Link>　𐄁　<Link href="/acceptable-use">Acceptable Use</Link>　𐄁　<Link href="/data-processing">Data Processing</Link>　𐄁　<Link href="/security">Security</Link>　𐄁　<Link href="/cookies">Cookies</Link>　𐄁　<Link href="/support">Support</Link></p></footer>

  </div>;
}

/* A silver Win95 window holding one block of page content, built from the homepage's product window. */
export function Panel({ title, kicker, heading, status, id, wide = false, children }: { title: string; kicker?: string; heading?: ReactNode; status: string; id?: string; wide?: boolean; children: ReactNode }) {
  return <section id={id} className={`${s.window} ${s.productWindow} ${d.panel} ${wide ? d.wide : ""}`}>
    <div className={s.titleBar}><span><img src={asset("b319737156808921.webp")} alt="" />{title}</span></div>
    <div className={`${s.productBody} ${d.body}`}>{kicker && <p className={s.productKicker}>{kicker}</p>}{heading && <h2 className={d.heading}>{heading}</h2>}{children}</div>
    <div className={s.statusBar}><span>{status}</span></div>
  </section>;
}
