import Link from "next/link";
import Footer from "@/components/Footer";
import ScrollReveal from "@/components/ScrollReveal";
import M9RMark from "@/components/M9RMark";
import M9RPersonalMark from "@/components/M9RPersonalMark";
import InstallCommand from "@/components/product/InstallCommand";
import LpThemeToggle from "@/components/product/LpThemeToggle";

/**
 * M9R — public homepage.
 * ----------------------------------------------------------------------------
 * Two-column hero (text left, the animated mark right), matching the closest
 * direct comp's own layout instead of a full-bleed hero followed by a
 * separate closing-visual section that added scroll for no real reason. The
 * mark itself is now a real WebGL shader (@paper-design/shaders-react's
 * LiquidMetal, found via 21st.dev's "Liquid & metal" category), not a
 * hand-rolled CSS gradient. The substance that used to live in on-page
 * sections lives at /memo instead.
 *
 * Copy rules: no spaced-hyphen clause connectors, no "X, not Y" antithesis, no
 * guaranteed savings/prevention, no cryptographic or real-time-supervision
 * overclaims. Runs, the Run Ledger, and the Run Passport are cut as
 * user-facing concepts; nothing on this page may reintroduce them.
 */

const CTA_PRIMARY = { href: "/agents", label: "Connect your first agent" };

export default function Home() {
  return (
    <div className="lp lp-min">
      <ScrollReveal />
      <MinimalNav />
      <main>
        <Hero />
      </main>
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Nav — three text links, no wordmark in the bar itself (the mark lives in   */
/* the hero), matching the closest comp's own restraint.                     */
/* -------------------------------------------------------------------------- */

function MinimalNav() {
  return (
    <nav className="lp-min-nav">
      <div className="lp-wrap lp-min-nav-in">
        <Link href="/" className="lp-min-brand">
          <M9RMark className="lp-min-brand-mark" />
          <span>M9R</span>
        </Link>
        <div className="lp-min-nav-links">
          <Link href="/auth">Sign in</Link>
          <Link href="/memo">Memo</Link>
          <Link href="mailto:contact@m9r.dev">Contact</Link>
          <LpThemeToggle />
        </div>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero — two columns. The mark is the closing visual now, moved into the    */
/* hero itself instead of a separate section, so the page stops at one       */
/* screen's worth of scroll instead of continuing to a second exhibit.       */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="lp-wrap lp-min-hero lp-min-hero-split">
      <div className="lp-min-hero-text">
        <h1 className="lp-h1 animate-fade-in">
          Your agents work together now.
          <br />
          <span className="lp-hot">Nothing ships without you.</span>
        </h1>

        <p className="lp-lede animate-fade-in">
          Claude Code and Codex work the same repo together, aware of each other&rsquo;s edits in real
          time. What one learns becomes memory the whole team carries forward.
        </p>

        <div className="lp-cta-row animate-fade-in">
          <Link href={CTA_PRIMARY.href} className="lp-btn lp-btn-primary">
            {CTA_PRIMARY.label}
          </Link>
        </div>

        <InstallCommand className="animate-fade-in" />

        <Link href="/agents" className="lp-min-for-agents animate-fade-in">
          For agents
        </Link>
      </div>

      <div className="lp-min-hero-mark animate-fade-in">
        <M9RPersonalMark width={320} height={320} />
      </div>
    </section>
  );
}
