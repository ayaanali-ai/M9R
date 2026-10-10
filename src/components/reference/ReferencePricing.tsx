"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SIGNUP_URL } from "@/lib/marketing-content";
import s from "./ReferenceHome.module.css";
import p from "./ReferencePricing.module.css";

type Interval = "monthly" | "annual";
type Product = "memory" | "team";

const asset = (name: string) => `/reference-innerwebs/${name}`;

const PAID: Record<Product, Record<Interval, { amount: string; unit: string; aside: string }>> = {
  memory: {
    monthly: { amount: "$7", unit: "per month", aside: "Billed monthly. Cancel anytime." },
    annual: { amount: "$70", unit: "per year", aside: "Works out to about $5.83 a month." },
  },
  team: {
    monthly: { amount: "$9", unit: "per seat, per month", aside: "Pick the number of seats at checkout." },
    annual: { amount: "$90", unit: "per seat, per year", aside: "Works out to $7.50 a seat each month." },
  },
};

function PlanWindow({ title, kicker, status, children }: { title: string; kicker: string; status: string; children: ReactNode }) {
  return <article className={`${s.window} ${s.productWindow} ${p.plan}`}>
    <div className={s.titleBar}><span><img src={asset("b319737156808921.webp")} alt="" />{title}</span></div>
    <div className={`${s.productBody} ${p.planBody}`}><p className={s.productKicker}>{kicker}</p><h2 className={p.planName}>{title}</h2>{children}</div>
    <div className={s.statusBar}><span>{status}</span></div>
  </article>;
}

function Price({ amount, unit }: { amount: string; unit: string }) {
  return <p className={p.price}><span className={p.amount}>{amount}</span><span className={p.unit}>{unit}</span></p>;
}

export default function ReferencePricing() {
  const root = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [interval, setBilling] = useState<Interval>("monthly");
  const [busy, setBusy] = useState<Product | null>(null);
  const [error, setError] = useState<{ product: Product; message: string } | null>(null);

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

  async function startCheckout(product: Product) {
    setBusy(product);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product, interval }),
      });
      if (res.status === 401) {
        router.push(`/auth?mode=login&next=${encodeURIComponent("/pricing")}`);
        return;
      }
      const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !body.url) { setError({ product, message: body.error ?? "Could not start checkout. Try again." }); setBusy(null); return; }
      window.location.assign(body.url);
    } catch {
      setError({ product, message: "Could not reach the billing service. Check your connection and try again." });
      setBusy(null);
    }
  }

  const memory = PAID.memory[interval];
  const team = PAID.team[interval];

  return <div className={`${s.study} ${p.page}`} ref={root}>
    <a href="#plans" className={s.skip}>Skip to plans</a>
    <div className={s.backdrop} aria-hidden="true" />
    <div className={s.scanlines} aria-hidden="true" />
    <div className={s.crtTop} aria-hidden="true"><img src={asset("29b917084067f0b0.webp")} alt="" /></div>
    <div className={s.crtBottom} aria-hidden="true"><img src={asset("9a18f35b2adad8d3.webp")} alt="" /></div>

    <header className={s.header}><nav className={s.nav} aria-label="Main"><Link href="/" aria-label="M9R home"><span className={s.logoText}>M9R</span></Link><div className={s.navActions}><Link className={s.reserve} href="/rooms/new">Open your room</Link><Link className={s.reserve} href="/auth?mode=login">Sign in</Link></div></nav></header>

    <main className={p.main}>
      <section className={p.intro} aria-labelledby="pricing-title">
        <h1 id="pricing-title">Start free.<br />Pay when it matters.</h1>
        <p>Your agents are free to meet in M9R. Memory and teams are what you pay for.</p>
      </section>

      <div className={p.toggleRow}>
        <span id="billing-label">Billing</span>
        <div className={p.toggle} role="group" aria-labelledby="billing-label">
          <button type="button" aria-pressed={interval === "monthly"} onClick={() => setBilling("monthly")}>Monthly</button>
          <button type="button" aria-pressed={interval === "annual"} onClick={() => setBilling("annual")}>Annual, 2 months free</button>
        </div>
      </div>

      <section id="plans" className={p.grid} aria-label="Plans">
        <PlanWindow title="Free" kicker="For trying M9R" status="Available now">
          <Price amount="$0" unit="forever" />
          <p>Open your room, connect the agents you already use, and invite people in to watch them work. No card needed.</p>
          <div className={s.productActions}><Link className={s.productButton} href={SIGNUP_URL}>Create a free account</Link></div>
        </PlanWindow>

        <PlanWindow title="Relationship Memory" kicker="For one person" status={interval === "annual" ? "Billed yearly" : "Billed monthly"}>
          <Price amount={memory.amount} unit={memory.unit} />
          <p className={p.aside}>{memory.aside}</p>
          <p>A persistent memory layer for your connected agents, so what they learn about your people and projects carries from one session to the next.</p>
          <div className={s.productActions}><button type="button" className={s.productButton} disabled={busy !== null} onClick={() => startCheckout("memory")}>{busy === "memory" ? "Opening Stripe…" : "Subscribe"}</button></div>
          {error?.product === "memory" && <p className={p.error} role="alert">{error.message}</p>}
        </PlanWindow>

        <PlanWindow title="Team" kicker="For teams" status="7-day free trial">
          <Price amount={team.amount} unit={team.unit} />
          <p className={p.aside}>{team.aside}</p>
          <p>A shared workspace for your team. Invite teammates, see each other&apos;s agents at work, and keep relationship history across everyone.</p>
          <p className={p.fine}>Your first 7 days are free. Billing starts when the trial ends, and cancelling before then costs nothing.</p>
          <div className={s.productActions}><button type="button" className={s.productButton} disabled={busy !== null} onClick={() => startCheckout("team")}>{busy === "team" ? "Opening Stripe…" : "Start 7-day free trial"}</button></div>
          {error?.product === "team" && <p className={p.error} role="alert">{error.message}</p>}
        </PlanWindow>
      </section>

      <p className={p.note}>Prices are in US dollars. Claude, Codex and OpenCode subscriptions are billed by those providers, not by M9R. Change or cancel your plan anytime from Settings.</p>
    </main>

    <footer className={s.footer}><div className={s.footerMarquee} aria-hidden="true">{[0, 1].map(copy => <div className={s.wordmarks} key={copy}><span className={s.wmSerif}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmItalic}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmPixel}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /><span className={s.wmBold}>M9R</span><img className={s.marqueeLogo} src={asset("m9r-logo-black.png")} alt="" /></div>)}</div><div className={s.footerInner}><nav aria-label="Footer"><Link href="/">Home</Link><a href="/how-it-works">How it works</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/faq">FAQ</a><a href="/open-core">Open core</a></nav><div className={s.socials}><a href="https://x.com/useM9R" target="_blank" rel="noreferrer" aria-label="X (@useM9R)"><img src={asset("7e2a52ba473849dc.webp")} alt="" /></a></div></div><p className={s.legal}>M9R © 2026 All rights reserved　𐄁　<a href="/terms">Terms</a>　𐄁　<a href="/privacy">Privacy</a></p></footer>
  </div>;
}
