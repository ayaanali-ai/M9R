import type { ReactNode } from "react";
import s from "./World.module.css";

/** Optional slot deliberately has no activation gesture until the surprise is approved. */
export default function HeroComputer({ screenInteraction }: { screenInteraction?: ReactNode }) {
  return <figure className={s.computer} aria-label="Original illustration: orange clay head floating in a sky-blue retro computer">
    <div className={s.monitor}><div className={s.screen} data-m9r-screen-slot="reserved">
      <span className={s.screenLabel}>M9R / SIGNAL FROM ELSEWHERE</span><div className={s.cloudOne} /><div className={s.cloudTwo} />
      <svg className={s.clay} viewBox="0 0 260 320" aria-hidden="true">
        <defs><radialGradient id="m9r-clay" cx="28%" cy="22%" r="83%"><stop stopColor="#ffd184"/><stop offset=".32" stopColor="#f89b46"/><stop offset=".67" stopColor="#e75c23"/><stop offset="1" stopColor="#8a2818"/></radialGradient><linearGradient id="m9r-nose" x2="1" y2=".3"><stop stopColor="#ffb35f"/><stop offset="1" stopColor="#c53e19"/></linearGradient><filter id="m9r-shadow"><feDropShadow dx="2" dy="10" stdDeviation="6" floodColor="#482516" floodOpacity=".25"/></filter></defs>
        <g filter="url(#m9r-shadow)"><path d="M102 238 94 283Q126 305 169 283L156 235" fill="url(#m9r-clay)"/><ellipse cx="58" cy="151" rx="19" ry="28" fill="#df612a"/><ellipse cx="199" cy="150" rx="17" ry="29" fill="#a63b1f"/><path d="M56 118Q52 55 95 35Q158 5 190 54Q214 85 202 165Q195 230 155 252Q121 266 89 235Q56 202 56 118Z" fill="url(#m9r-clay)"/><path d="M77 117Q94 101 111 116M150 113Q169 99 185 114" stroke="#aa421f" strokeWidth="10" strokeLinecap="round" fill="none"/><path d="M80 137Q96 148 110 134M151 133Q166 146 181 131" stroke="#782e1e" strokeWidth="5" strokeLinecap="round" fill="none"/><path d="M131 116Q128 153 116 176Q132 187 150 175" fill="url(#m9r-nose)"/><path d="M104 202Q132 219 161 198" stroke="#8e311d" strokeWidth="5" strokeLinecap="round" fill="none"/><path d="M108 211Q136 220 155 207" stroke="#fb9b54" strokeWidth="3" strokeLinecap="round" fill="none"/></g>
      </svg>
      {screenInteraction}<span className={s.screenCaption}>THE AIR BETWEEN AGENTS</span>
    </div><div className={s.monitorBottom}><strong>M9R</strong><span><i /> POWER</span><b aria-hidden="true">▥ ▥ ▥</b></div></div>
    <div className={s.monitorStand}/><div className={s.keyboard} aria-hidden="true"><div /><span>M9R PERSONAL CONNECTION SYSTEM</span></div>
    <figcaption>YOUR AGENTS. THEIR ENVIRONMENTS. A CONNECTION BETWEEN.</figcaption>
  </figure>;
}
