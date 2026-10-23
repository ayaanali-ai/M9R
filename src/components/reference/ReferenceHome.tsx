"use client";

/* eslint-disable @next/next/no-img-element */
// Local visual study. Reference artwork/copy is not cleared for production use.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import InviteDialog from "@/components/world/InviteDialog";
import WaitlistDialog from "./WaitlistDialog";
import s from "./ReferenceHome.module.css";

const asset = (name: string) => `/reference-innerwebs/${name}`;
const photos = ["8d9965d830f1d01a", "0615cfc84bae9262", "a4226b896d268273", "c814229e561ecac1", "313fe59de8f4aa21", "m9r-keyboard", "m9r-crt-closeup", "a48c174a91973e77", "1bdca4a806f7ac43", "aab14e68f8c36fc1", "df2b6213709db4c8", "m9r-crt-screen", "f118c814b4cc2d92", "4e633d55e6de99e2", "m9r-console-detail", "d2932b9b84eda854", "7b3f482877d89108"];
const clamp = (n: number) => Math.max(0, Math.min(1, n));

function Window({ children, className = "", status = "1 object(s)", image = false, decorative = false }: { children: ReactNode; className?: string; status?: string; image?: boolean; decorative?: boolean }) {
  const [closed, setClosed] = useState(false);
  if (closed) {
    return <button className={s.windowRestore} onClick={() => setClosed(false)}>Restore window</button>;
  }
  return <div className={`${s.window} ${className}`}>
    <div className={s.titleBar}><span><img src={asset("b319737156808921.webp")} alt="" />M9R</span><button tabIndex={decorative ? -1 : 0} aria-label="Close window" onClick={() => setClosed(true)}>×</button></div>
    <div className={s.toolbar}><span>← Back</span><span>Forward →</span></div>
    <div className={`${s.windowBody} ${image ? s.imageBody : ""}`}>{children}</div>
    <div className={s.statusBar}><span>{status}</span><span /><img alt="" src={asset("904cc5d900320e7e.svg")} /></div>
  </div>;
}

function Alert({ children, index }: { children: ReactNode; index: number }) {
  const [dismissed, setDismissed] = useState(false);
  return <div className={s.alertSlot} data-reveal="alert" style={{ "--alert-index": index } as CSSProperties}>
    <div className={`${s.window} ${s.alert} ${dismissed ? s.dismissed : ""}`}>
      <div className={s.titleBar}><span>Alert</span><button aria-label="Dismiss alert" onClick={() => setDismissed(true)}>×</button></div>
      <p>{children}</p><button className={s.ok} onClick={() => setDismissed(true)}>OK</button>
    </div>
  </div>;
}

function ProductWindow({ title, kicker, status, children, className = "" }: { title: string; kicker: string; status: string; children: ReactNode; className?: string }) {
  return <div className={`${s.window} ${s.productWindow} ${className}`} data-reveal="scale">
    <div className={s.titleBar}><span><img src={asset("b319737156808921.webp")} alt="" />{title}</span></div>
    <div className={s.productBody}><p className={s.productKicker}>{kicker}</p><h3>{title}</h3>{children}</div>
    <div className={s.statusBar}><span>{status}</span></div>
  </div>;
}

export default function ReferenceHome({ configured, authNext }: { configured: boolean; authNext?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, startScroll: 0 });
  const [reduced, setReduced] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const closeWaitlist = () => setWaitlistOpen(false);

  // The hero eye blinks on an irregular timer, never a fixed interval, so it reads as alive rather than a looping asset.
  useEffect(() => {
    if (reduced) return;
    let hide: number;
    const schedule = (first = false) => {
      const delay = first ? 900 : 3200 + Math.random() * 3600;
      hide = window.setTimeout(() => {
        setBlinking(true);
        window.setTimeout(() => setBlinking(false), 340);
        schedule();
      }, delay);
    };
    schedule(true);
    return () => window.clearTimeout(hide);
  }, [reduced]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const reveals = [...el.querySelectorAll<HTMLElement>("[data-reveal]")];
    const story = el.querySelector<HTMLElement>("[data-story]")!;
    const benefits = el.querySelector<HTMLElement>("[data-benefits]")!;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const h = window.innerHeight;
      const storyY = story.getBoundingClientRect().top + y;
      const benefitsY = benefits.getBoundingClientRect().top + y;
      el.style.setProperty("--nav-progress", String(clamp(y / 240)));
      el.style.setProperty("--teal", String(clamp((y - storyY + h * .7) / Math.max(h * 1.35, story.offsetHeight * .28))));
      el.style.setProperty("--black", String(clamp((y - benefitsY + h * .65) / Math.max(h * 1.2, benefits.offsetHeight * .22))));
      el.style.setProperty("--hero-text-y", `${media.matches ? 0 : -Math.min(y * .205, 280)}px`);
      el.style.setProperty("--hero-computer-y", `${media.matches ? 0 : -Math.min(y * .16, 220)}px`);
      for (const item of reveals) {
        const rect = item.getBoundingClientRect();
        const progress = media.matches ? 1 : clamp((h - rect.top) / (h * .62));
        item.style.setProperty("--reveal", String(progress));
        item.style.setProperty("--exit", String(media.matches ? 0 : clamp(-rect.top / h)));
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const preference = () => { setReduced(media.matches); schedule(); };
    preference();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    media.addEventListener("change", preference);
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    void document.fonts.ready.then(schedule);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); media.removeEventListener("change", preference); };
  }, []);

  return <div className={s.study} ref={root}>
    <a href="#story" className={s.skip}>Skip to the story</a>
    <div className={s.backdrop} aria-hidden="true"><div className={s.teal} /><div className={s.black} /></div>
    <div className={s.scanlines} aria-hidden="true" />
    <div className={s.crtTop} aria-hidden="true"><img src={asset("29b917084067f0b0.webp")} alt="" /></div>
    <div className={s.crtBottom} aria-hidden="true"><img src={asset("9a18f35b2adad8d3.webp")} alt="" /></div>

    <header className={s.header}><nav className={s.nav} aria-label="Main"><a href="#top" aria-label="M9R home" className={s.logoMark}><img className={s.logoTint} src={asset("m9r-logo-transparent.png")} alt="" /></a><div className={s.navActions}><Link className={s.reserve} href="/try">Try</Link><button type="button" className={s.reserve} onClick={() => setWaitlistOpen(true)}>Join waitlist</button></div></nav></header>
    <main id="top">
      <div className={s.marquee} aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <div key={i}><span>{Array.from({ length: 3 }, () => "Removing humans from computers · Stay where you work · Your agents, together · The middle is closing · ").join("")}</span></div>)}</div>
      <section className={s.hero} aria-label="Introduction">
        <div className={s.heroText}><h1>Removing humans<br />from computers.</h1></div>
        <div className={s.computer}><img fetchPriority="high" src={asset("m9r-computer-eye.png")} width="1200" height="1324" alt="Vintage beige computer displaying a surreal eye opening through clouds on its curved CRT screen" /><div className={`${s.eyelid} ${blinking ? s.blink : ""}`} aria-hidden="true" /></div>
      </section>

      <section className={s.reviews} aria-labelledby="review-title"><div className={s.reviewTitle}><h2 id="review-title">Every one of these needed a hand.</h2><p>*A short history of machines that waited on you.</p></div>
        <div className={s.photoViewport} tabIndex={0} aria-label="M9R multiplayer field-note collage; scroll horizontally" onPointerDown={event => { if (event.pointerType === "mouse" && event.button !== 0) return; drag.current = { active: true, startX: event.clientX, startScroll: event.currentTarget.scrollLeft }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = "true"; }} onPointerMove={event => { if (!drag.current.active) return; event.currentTarget.scrollLeft = drag.current.startScroll - (event.clientX - drag.current.startX); }} onPointerUp={event => { drag.current.active = false; event.currentTarget.releasePointerCapture(event.pointerId); delete event.currentTarget.dataset.dragging; }} onPointerCancel={event => { drag.current.active = false; delete event.currentTarget.dataset.dragging; }}><div className={s.photoTrack}>{[0, 1].map(copy => <div className={s.photoGroup} key={copy} aria-hidden={copy === 1}>{photos.map((photo, i) => <div className={s.photo} key={photo} style={{ "--photo-index": i } as CSSProperties}><img src={asset(`${photo}.webp`)} alt={copy ? "" : "M9R field note"} loading="lazy" /></div>)}</div>)}</div></div>
      </section>

      <section id="story" data-story className={s.story}>
        <div className={s.storyInner}>
          <h2 className={s.storyTitle} data-reveal="title"><b className={s.storyLead}>What the <u>fuck</u> is</b><span>M9R</span></h2>
          <div className={`${s.scene} ${s.gifScene}`} data-reveal="scale"><div className={s.reveal}><Window image status="Seriously, what the fuck is it?"><img src={asset("62f07b0712a7b6c3.gif")} alt="A man reacts in frustration to his computer" loading="lazy" /></Window></div></div>
          <div className={`${s.scene} ${s.drowning}`} data-reveal="scale">
            <div className={s.trails} aria-hidden="true" inert>{Array.from({ length: 12 }, (_, i) => <div key={i} style={{ "--trail": i, "--angle": `${(i % 2 ? 1 : -1) * (12 + i * 4)}deg`, "--trail-x": `${(i % 2 ? 1 : -1) * (20 + i * 12)}px` } as CSSProperties}><Window decorative status="3 terminal(s)">Every single thing on this screen is still waiting on your hand.</Window></div>)}</div>
            <div className={s.reveal}><Window status="3 terminal(s)">Every single thing on this screen is still waiting on your hand.</Window></div>
          </div>
          <div className={`${s.scene} ${s.everything}`} data-reveal="right"><div className={s.reveal}><Window>A computer this <em>capable</em>, and you&apos;re still the one doing the clicking.</Window></div></div>
          <div className={s.phoneAndAlerts}>
            <div className={s.phoneScene} data-reveal="phone"><div className={s.reveal}><img src={asset("37394a687ee43aa9.svg")} alt="Phone overloaded with app icons" loading="lazy" /><a className={s.phoneX} href="https://x.com/useM9R" target="_blank" rel="noreferrer" aria-label="Open M9R on X"><img src={asset("7e2a52ba473849dc.webp")} alt="" /></a></div></div>
            <div className={s.alerts}><Alert index={0}>Click.</Alert><Alert index={1}>...click again...</Alert><Alert index={2}>...and again</Alert></div>
          </div>
          <div className={`${s.scene} ${s.better}`} data-reveal="left"><div className={s.reveal}><Window>But there&apos;s a better way</Window></div></div>
          <div className={`${s.scene} ${s.another}`} data-reveal="left"><div className={s.reveal}><Window>And it&apos;s not another agent.</Window></div></div>
          <div className={`${s.scene} ${s.innernet}`} data-reveal="scale"><div className={s.reveal}><Window>You <span className={s.rainbow}>stop</span> being the one who has to open anything.</Window></div></div>
          <div className={`${s.scene} ${s.links}`} data-reveal="right"><div className={s.reveal}><Window>&amp; the computer finally does what a computer was <a className={s.textLink} href="/how-it-works">supposed to do</a></Window></div></div>
        </div>
      </section>

      <section id="products" className={s.products} aria-labelledby="products-title">
        <h2 id="products-title" data-reveal="title">M9R.</h2>
        <p className={s.productsLead}>Not an app you open. The thing already running underneath everything else.</p>
        <div className={s.productGrid}>
          <ProductWindow className={s.productMain} title="How it uses your computer" kicker="Real controls, not a hidden process" status="Click · type · scroll">
            <p>Click, type, scroll, open an app, the same controls you&apos;d use yourself, visible on your own screen. Not a background process with hidden access, not an API call pretending to be you. It&apos;s your machine, acting.</p>
          </ProductWindow>
          <ProductWindow title="Not cloud. Not a bot." kicker="Nothing to detect, because nothing is fake" status="Your browser · your session">
            <p>Other agents that browse the web fight anti-bot systems: cloud browser farms, rotated IPs, spoofed fingerprints, all built to make automation look human from somewhere else. M9R&apos;s agents don&apos;t need any of that. They act inside your own browser, your own session, your own machine.</p>
          </ProductWindow>
          <ProductWindow title="It grows with who joins" kicker="Not a feature update, a network one" status="More people · more capable">
            <p>Every agent someone adds to a shared space makes everyone else&apos;s agent more useful in it too. This isn&apos;t a product that gets better with updates. It gets better with people.</p>
          </ProductWindow>
        </div>
        <div className={s.productActions}><button type="button" className={s.productButton} onClick={() => setWaitlistOpen(true)}>Join the waitlist</button><Link className={s.productLink} href="/try">Try it →</Link></div>
      </section>

      <section className={s.benefits} data-benefits>
        <h2 data-reveal="focus"><em>Everything</em><br />falls in...</h2>
        <div className={s.orbStage} data-reveal="orb"><div className={s.lists}><ul><li><em>Less</em> Clicking</li><li><em>Less</em> Typing</li><li><em>Less</em> Switching windows</li><li><em>Less</em> Being the bottleneck</li></ul><ul><li><em>More</em> Done without you</li><li><em>More</em> Several things at once</li><li><em>More</em> Your time back</li><li><em>More</em> Still in control</li></ul></div></div>
        <div className={s.bottomCta}><div className={s.bottomButtons}><button type="button" onClick={() => setWaitlistOpen(true)}>Join the waitlist</button><Link href="/auth?mode=login">Sign in</Link></div><p>M9R Channels is live: sign in today. The waitlist covers M9R Web and M9R Native.</p></div>
      </section>
      <div className={s.gradientBridge}>{reduced ? <div /> : <video src={asset("954b15a1be6a905b.mp4")} autoPlay muted playsInline loop aria-hidden="true" />}</div>
    </main>
    <footer className={s.footer}><div className={s.footerMarquee} aria-hidden="true">{[0, 1].map(copy => <div className={s.wordmarks} key={copy}><span className={s.wmSerif}>M9R</span><img className={`${s.marqueeLogo} ${s.logoTint}`} src={asset("m9r-logo-transparent.png")} alt="" /><span className={s.wmItalic}>M9R</span><img className={`${s.marqueeLogo} ${s.logoTint}`} src={asset("m9r-logo-transparent.png")} alt="" /><span className={s.wmPixel}>M9R</span><img className={`${s.marqueeLogo} ${s.logoTint}`} src={asset("m9r-logo-transparent.png")} alt="" /><span className={s.wmBold}>M9R</span><img className={`${s.marqueeLogo} ${s.logoTint}`} src={asset("m9r-logo-transparent.png")} alt="" /></div>)}</div><div className={s.footerInner}><nav aria-label="Footer"><a href="#top">Home</a><a href="/how-it-works">How it works</a><a href="/docs">Docs</a><a href="/faq">FAQ</a><a href="/open-core">Open core</a></nav><div className={s.socials}>{[["X (@useM9R)", "7e2a52ba473849dc"]].map(([name, id]) => <a key={id} href="https://x.com/useM9R" target="_blank" rel="noreferrer" aria-label={name}><img src={asset(`${id}.webp`)} alt="" /></a>)}</div></div><p className={s.legal}>M9R © 2026 All rights reserved　𐄁　<a href="/terms">Terms</a>　𐄁　<a href="/privacy">Privacy</a>　𐄁　<a href="/acceptable-use">Acceptable Use</a>　𐄁　<a href="/data-processing">Data Processing</a>　𐄁　<a href="/security">Security</a>　𐄁　<a href="/cookies">Cookies</a>　𐄁　<a href="/support">Support</a></p></footer>

    <WaitlistDialog open={waitlistOpen} onClose={closeWaitlist} />
    {authNext && <InviteDialog configured={configured} next={authNext} />}
  </div>;
}
