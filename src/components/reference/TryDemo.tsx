"use client";

import Link from "next/link";
import { useState } from "react";
import WaitlistDialog from "./WaitlistDialog";
import s from "./TryDemo.module.css";

const Arrow = ({ color }: { color: string }) => (
  <svg className={s.cursorArrow} viewBox="0 0 16 16" fill="none">
    <path d="M2 1.2 L2 13.6 L5.1 10.8 L7.3 14.9 L9 14 L6.9 10 L11 10 Z" fill={color} stroke="#0b0c0f" strokeWidth="1" strokeLinejoin="round" />
  </svg>
);

const NotesTile = ({ size = 16 }: { size?: number }) => (
  <span className="tile" style={{ background: "linear-gradient(160deg,#fff6df,#f0c15a)" }}>
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"><path d="M5 3h10l4 4v14H5z" fill="#fff" /><path d="M15 3v4h4" fill="#e9c988" /><path d="M8 11h8M8 14.5h8M8 18h5" stroke="#b9872c" strokeWidth="1.5" /></svg>
  </span>
);
const PaintTile = ({ size = 16 }: { size?: number }) => (
  <span className="tile" style={{ background: "linear-gradient(160deg,#7fd6ff,#2f8fe0)" }}>
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"><path d="M12 3.5c-4.7 0-8.5 3.7-8.5 8.3 0 3.9 2.9 6.2 5.6 6.2.9 0 1.2-.5.8-1.2-.3-.5-.5-1-.1-1.5.3-.4.8-.4 1.4-.4 3.9 0 7.3-2.6 7.3-6.6 0-2.7-2.6-4.8-6.5-4.8Z" fill="#fff" /><circle cx="8.3" cy="10.5" r="1.3" fill="#D97757" /><circle cx="11.7" cy="7.8" r="1.3" fill="#2f6fed" /><circle cx="15" cy="10" r="1.3" fill="#34D399" /><circle cx="9.3" cy="14.3" r="1.3" fill="#f0c15a" /></svg>
  </span>
);
const MusicTile = ({ size = 16 }: { size?: number }) => (
  <span className="tile" style={{ background: "linear-gradient(160deg,#34D399,#189066)" }}>
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"><circle cx="12" cy="12" r="8.5" fill="#fff" fillOpacity=".16" /><path d="M9.5 8.3 16 12l-6.5 3.7Z" fill="#fff" /></svg>
  </span>
);
const PlayIcon = () => <svg viewBox="0 0 24 24" width="10" height="10"><path d="M8 5v14l11-7Z" fill="#0b0c0f" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" width="10" height="10"><rect x="6" y="5" width="4" height="14" fill="#0b0c0f" /><rect x="14" y="5" width="4" height="14" fill="#0b0c0f" /></svg>;
const SkipIcon = () => <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#4b4b52" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5v14l9-7Z" /><path d="M18 5v14" /></svg>;
const StartMark = () => (
  <svg viewBox="0 0 24 24" width="13" height="13"><rect x="3" y="3" width="8" height="8" fill="#141210" /><rect x="13" y="3" width="8" height="8" fill="#141210" opacity=".7" /><rect x="3" y="13" width="8" height="8" fill="#141210" opacity=".7" /><rect x="13" y="13" width="8" height="8" fill="#141210" opacity=".45" /></svg>
);

/**
 * An ambient, looping visual preview, not a live M9R session: it illustrates three agents on one desktop,
 * with one moment where Claude calls Codex over and Codex travels, helps, and goes back.
 */
export default function TryDemo() {
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  return (
    <div className={s.page}>
      <div className={s.backdrop} aria-hidden="true" />
      <div className={s.scanlines} aria-hidden="true" />
      <div className={s.crtTop} aria-hidden="true"><img src="/reference-innerwebs/29b917084067f0b0.webp" alt="" /></div>
      <div className={s.crtBottom} aria-hidden="true"><img src="/reference-innerwebs/9a18f35b2adad8d3.webp" alt="" /></div>

      <header className={s.header}>
        <nav className={s.nav} aria-label="Main">
          <Link href="/" className={s.back} aria-label="Back to M9R home">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
            <img className={s.logoTint} src="/reference-innerwebs/m9r-logo-transparent.png" alt="" />
          </Link>
          <button type="button" className={s.reserve} onClick={() => setWaitlistOpen(true)}>Join waitlist</button>
        </nav>
      </header>

      <div className={s.intro}>
        <div className={s.kicker}>Animated preview · concept only</div>
        <h1 className={s.title}>Not a task list. A desktop with more than one hand on it.</h1>
        <p className={s.sub}>A visual concept for three agents sharing one computer. This animation is illustrative; it is not a live M9R session.</p>
      </div>

      <div className={s.stageWrap}>
        <div className={s.desktop} aria-hidden="true">
          <svg className={s.ribbon} viewBox="0 0 1000 625" preserveAspectRatio="xMidYMid slice">
            <path d="M-50 480 C 180 380, 320 560, 520 420 S 880 300, 1050 380" stroke="#8fc0ff" strokeWidth="90" fill="none" strokeLinecap="round" opacity=".35" />
            <path d="M-60 340 C 160 420, 380 260, 560 340 S 860 460, 1060 300" stroke="#c9b8ff" strokeWidth="60" fill="none" strokeLinecap="round" opacity=".3" />
          </svg>

          <div className={`${s.deskIcon} ${s.iconNotes}`}><NotesTile size={20} /><span className="lbl">Notes</span></div>
          <div className={`${s.deskIcon} ${s.iconPaint}`}><PaintTile size={20} /><span className="lbl">Paint</span></div>
          <div className={`${s.deskIcon} ${s.iconMusic}`}><MusicTile size={20} /><span className="lbl">Music</span></div>

          <div className={`${s.win} ${s.notesWin}`}>
            <div className={s.winBar}><NotesTile /><span className="name">Notes</span><span className="dots"><span /><span /><span /></span></div>
            <div className={s.winBody}>
              <div className={`${s.noteLine}`}>Standup notes for today</div>
              <div className={`${s.noteLine} ${s.l2}`}>Fixed the login timeout bug</div>
              <div className={`${s.noteLine} ${s.l3}`}><span className="before">Still need to test it</span><span className="after">Also verify it on mobile</span></div>
              <div className={s.editMark}>Codex: added &quot;verify it on mobile&quot;, worth checking before this ships</div>
            </div>
          </div>

          <div className={`${s.win} ${s.paintWin}`}>
            <div className={s.winBar}><PaintTile /><span className="name">Paint</span><span className="dots"><span /><span /><span /></span></div>
            <div className={s.canvas}>
              <svg className={s.canvasPath} viewBox="0 0 240 180" preserveAspectRatio="none">
                <path className={s.strokePath} d="M18 130 C 60 40, 120 40, 140 90 S 200 150, 222 60" />
              </svg>
            </div>
          </div>

          <div className={`${s.win} ${s.musicWin}`}>
            <div className={s.winBar}><MusicTile /><span className="name">Music</span><span className="dots"><span /><span /><span /></span></div>
            <div className={s.winBody}>
              <div className={s.track}>
                <div className={s.trackArt}><MusicTile size={14} /></div>
                <div className={s.trackInfo}><b>Now playing</b>Late Build, Low Volume</div>
                <div className={s.transport}>
                  <button className="play">
                    <span className={s.playIcon}><PlayIcon /></span>
                    <span className={s.pauseIcon}><PauseIcon /></span>
                    <span className={s.clickRing} />
                  </button>
                  <button><SkipIcon /></button>
                </div>
              </div>
            </div>
          </div>

          <div className={s.callBubble}>Codex, a second opinion?</div>

          <div className={`${s.cursor} ${s.claude}`}><Arrow color="#D97757" /><span className={s.cursorLabel}>Claude</span></div>
          <div className={`${s.cursor} ${s.codex}`}><Arrow color="#7AA2F7" /><span className={s.cursorLabel}>Codex</span></div>
          <div className={`${s.cursor} ${s.opencode}`}><Arrow color="#34D399" /><span className={s.cursorLabel}>OpenCode</span></div>

          <div className={s.taskbar}>
            <div className={s.taskCenter}>
              <div className={s.startOrb}><StartMark /></div>
              <div className={s.taskApp}><NotesTile /></div>
              <div className={s.taskApp}><PaintTile /></div>
              <div className={s.taskApp}><MusicTile /></div>
            </div>
          </div>
        </div>
      </div>

      <WaitlistDialog open={waitlistOpen} onClose={() => setWaitlistOpen(false)} />
    </div>
  );
}
