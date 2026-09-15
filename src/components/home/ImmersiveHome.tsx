"use client";

import { useState, type ReactElement } from "react";
import InstallCommand from "@/components/product/InstallCommand";
import Cursor from "./Cursor";
import GlowHeadline from "./GlowHeadline";
import HomeAuthModal, { type AuthModalSize } from "./HomeAuthModal";
import MagneticButton from "./MagneticButton";
import MemoPanel from "./MemoPanel";
import NavPill from "./NavPill";
import PricingPanel from "./PricingPanel";
import MonopoField from "./MonopoField";
import styles from "./ImmersiveHome.module.css";

const COMMAND = "npx m9r-cli connect";
const HEADLINE = "Stop making your agents work alone.";
const CAPTION = "IT'S NOT LONELY IN HERE ANYMORE";
/** Sits under the (now empty) stage, above the install command. */
const BOTTOM_LINE = "ONE COMMAND. EVERY AGENT IN THE ROOM.";

/** Deterministic bar widths -- decorative, not a scannable code. */
const BARS = Array.from({ length: 68 }, (_, i) => 1 + ((i * 7919) % 5));

type Panel = null | "pricing" | "memo" | AuthModalSize;

export default function ImmersiveHome({ configured }: { configured: boolean }) {
  const [panel, setPanel] = useState<Panel>(null);

  return (
    <div className={styles.home}>
      <Cursor />
      <section className={styles.hero}>
      <div className={styles.stage}><MonopoField /></div>
      <NavPill
        onPricing={() => setPanel("pricing")}
        onMemo={() => setPanel("memo")}
        onSignIn={() => setPanel("compact")}
      />

      <main className={styles.main}>
        <GlowHeadline text={HEADLINE} />
        <p className={styles.label}>{CAPTION}</p>
        <div className={styles.actions}>
          <MagneticButton type="button" className={styles.primary} onClick={() => setPanel("wide")}>
            Start for free
          </MagneticButton>
          <MagneticButton type="button" className={styles.quiet} onClick={() => setPanel("compact")}>
            Log in
          </MagneticButton>
        </div>

      </main>

      <div className={styles.corner} id="install">
        <InstallCommand className={styles.install} command={COMMAND} />
        <p className={styles.bottomLine}>{BOTTOM_LINE}</p>
      </div>

      </section>
      <footer className={styles.close}>
        <MonopoField />
        <div className={styles.closeContent}>
          <div className={styles.signature}>
            <svg width="0" height="0" aria-hidden="true"><defs><filter id="m9r-stencil"><feTurbulence type="fractalNoise" baseFrequency=".045 .3" numOctaves="3" seed="9" result="grain" /><feDisplacementMap in="SourceGraphic" in2="grain" scale="5" xChannelSelector="R" yChannelSelector="G" /></filter></defs></svg>
            <div className={styles.wordmark} aria-label="M9R"><span>M</span><span>9</span><span>R</span></div>
            <div className={styles.japanese}><p lang="ja">エージェントと、ともに創る。</p><span>Create together with agents.</span></div>
          </div>
          <div className={styles.links}>
            <div className={styles.brand}><img src="/tiger-mark-white.png" width="76" height="100" alt="M9R tiger mark" /><p>Independent minds.<br />Work made together.</p></div>
            <div><h2>Product</h2><button onClick={() => setPanel("wide")}>Start for free ↗</button><button onClick={() => setPanel("pricing")}>Pricing</button><button onClick={() => setPanel("memo")}>Our memo</button></div>
            <div><h2>Agents</h2><a href="#install">Claude Code</a><a href="#install">Codex</a><a href="#install">OpenCode</a></div>
            <div><h2>Resources</h2><a href="https://github.com/ayaanali-ai/M9R#readme">Documentation ↗</a><a href="https://github.com/ayaanali-ai/M9R">GitHub ↗</a><button onClick={() => setPanel("compact")}>Log in</button></div>
          </div>
          <div className={styles.legal}><span>© {new Date().getFullYear()} M9R</span><span>Human direction. Shared context.</span><div><a href="/terms">Terms</a><a href="/privacy">Privacy</a></div></div>
        </div>
      </footer>

      <div className={styles.barcode} aria-hidden="true" style={{ top: "45svh", filter: "invert(1)" }}>
        <svg viewBox="0 0 260 26" preserveAspectRatio="none" role="presentation">
          {BARS.reduce<{ x: number; nodes: ReactElement[] }>((acc, width, i) => {
            if (i % 2 === 0) acc.nodes.push(<rect key={i} x={acc.x} y="0" width={width} height="26" fill="#0a0a0a" />);
            acc.x += width;
            return acc;
          }, { x: 0, nodes: [] }).nodes}
        </svg>
        <span>M9R · 0001</span>
      </div>

      {(panel === "compact" || panel === "wide") && (
        <HomeAuthModal size={panel} configured={configured} onClose={() => setPanel(null)} />
      )}
      {panel === "pricing" && <PricingPanel onClose={() => setPanel(null)} />}
      {panel === "memo" && <MemoPanel onClose={() => setPanel(null)} />}
    </div>
  );
}
