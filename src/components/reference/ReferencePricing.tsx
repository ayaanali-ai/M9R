"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CONTACT_MAILTO } from "@/lib/contact";
import { FOUNDING_COHORT_SIZE, FOUNDING_MONTHLY_PRICE_USD, STANDARD_MONTHLY_PRICE_USD } from "@/lib/stripe";
import s from "./ReferenceHome.module.css";
import p from "./ReferencePricing.module.css";

const asset = (name: string) => `/reference-innerwebs/${name}`;

export default function ReferencePricing() {
  const root = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

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

  useEffect(() => {
    fetch("/api/billing/cohort").then(async (res) => {
      if (!res.ok) return;
      const body = await res.json().catch(() => null) as { remaining?: number } | null;
      if (typeof body?.remaining === "number") setRemaining(body.remaining);
    }).catch(() => undefined);
  }, []);

  const founding = remaining === null || remaining > 0;
  const price = founding ? FOUNDING_MONTHLY_PRICE_USD : STANDARD_MONTHLY_PRICE_USD;

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (res.status === 401) {
        router.push(`/auth?mode=login&next=${encodeURIComponent("/pricing")}`);
        return;
      }
      const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !body.url) { setError(body.error ?? "Could not start checkout. Try again."); setBusy(false); return; }
      window.location.assign(body.url);
    } catch {
      setError("Could not reach the billing service. Check your connection and try again.");
      setBusy(false);
    }
  }

  return <div className={`${s.study} ${p.page}`} ref={root}>
    <a href="#plan" className={s.skip}>Skip to the price</a>
    <div className={s.backdrop} aria-hidden="true" />
    <div className={s.scanlines} aria-hidden="true" />
    <div className={s.crtTop} aria-hidden="true"><img src={asset("29b917084067f0b0.webp")} alt="" /></div>
    <div className={s.crtBottom} aria-hidden="true"><img src={asset("9a18f35b2adad8d3.webp")} alt="" /></div>

    <header className={s.header}><nav className={s.nav} aria-label="Main"><Link href="/" aria-label="M9R home"><span className={s.logoText}>M9R</span></Link><div className={s.navActions}><Link className={s.reserve} href="/rooms/new">Open your room</Link><Link className={s.reserve} href="/auth?mode=login">Sign in</Link></div></nav></header>

    <main className={p.main}>
      <section className={p.intro} aria-labelledby="pricing-title">
        <h1 id="pricing-title">One price. One computer.<br />No seats to count.</h1>
        <p>Every other agent tool prices you by headcount, by usage, by a tier you have to decode. We priced it the way we&apos;d want it priced if we were buying it: once, honestly, and the same for everyone who buys at the same time.</p>
      </section>

      <section id="plan" className={p.grid} aria-label="Plan">
        <article className={`${s.window} ${s.productWindow} ${p.plan}`}>
          <div className={s.titleBar}><span><img src={asset("b319737156808921.webp")} alt="" />M9R</span></div>
          <div className={`${s.productBody} ${p.planBody}`}>
            <p className={s.productKicker}>Per computer. Not per seat.</p>
            <h2 className={p.planName}>M9R</h2>
            <p className={p.price}><span className={p.amount}>${price}</span><span className={p.unit}>per month, per computer</span></p>
            <p className={p.aside}>
              {founding
                ? `Locked for life, as one of the first ${FOUNDING_COHORT_SIZE}. The price doesn't go up on you later.`
                : `The first ${FOUNDING_COHORT_SIZE} are taken. $27 is locked for you too — it just won't go up from here, same as it was for them.`}
            </p>
            <p>Every agent you already pay for — Claude, Codex, whatever you run — gets to actually use the computer in front of you. No per-agent fee on top. No tier to upgrade into.</p>
            <div className={s.productActions}>
              <button type="button" className={s.productButton} disabled={busy} onClick={startCheckout}>{busy ? "Opening Stripe…" : `Get M9R — $${price}/month`}</button>
            </div>
            {error && <p className={p.error} role="alert">{error}</p>}
            {remaining !== null && founding && (
              <p className={p.fine}>{remaining} of {FOUNDING_COHORT_SIZE} founding spots left at $17.</p>
            )}
          </div>
          <div className={s.statusBar}><span>{founding ? "Founding price, while it lasts" : "Standard price"}</span></div>
        </article>
      </section>

      <section className={p.toggleRow} style={{ flexDirection: "column", gap: 8 }} aria-label="What's included">
        <p className={p.note} style={{ textAlign: "center" }}>
          No free tier, no trial gimmick — just a clear price for a computer that actually does something.
          Running a fleet of machines, or need a contract? <a href={CONTACT_MAILTO}>Talk to us</a> — we price that by hand, not by a pricing page.
        </p>
        <p className={p.note} style={{ textAlign: "center" }}>Prices are in US dollars. Claude, Codex, and OpenCode subscriptions are billed by those providers, not by M9R. Cancel anytime from Settings.</p>
      </section>
    </main>

    <footer className={s.footer}><div className={s.footerMarquee} aria-hidden="true">{[0, 1].map(copy => <div className={s.wordmarks} key={copy}><span className={s.wmSerif}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmItalic}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmPixel}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmBold}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /></div>)}</div><div className={s.footerInner}><nav aria-label="Footer"><Link href="/">Home</Link><a href="/how-it-works">How it works</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/faq">FAQ</a><a href="/open-core">Open core</a></nav><div className={s.socials}><a href="https://x.com/useM9R" target="_blank" rel="noreferrer" aria-label="X (@useM9R)"><img src={asset("7e2a52ba473849dc.webp")} alt="" /></a></div></div><p className={s.legal}>M9R © 2026 All rights reserved　𐄁　<a href="/terms">Terms</a>　𐄁　<a href="/privacy">Privacy</a></p></footer>
  </div>;
}
