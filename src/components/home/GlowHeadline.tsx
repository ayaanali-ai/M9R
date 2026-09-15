"use client";

import { useEffect, useRef } from "react";
import { pointer } from "./pointer";
import styles from "./GlowHeadline.module.css";

/** How heavily the color blob lags the real cursor -- lower = more liquid. */
const EASE = 0.07;
/** Blob radius, in px, before the soft feathered edge starts. */
const RADIUS = 130;
/** Full hue cycle length, in ms -- color drifts slowly, doesn't strobe. */
const HUE_PERIOD = 14000;

/**
 * Second attempt at the Pony-style "paint" cursor effect: rather than each
 * letter snapping to a proximity value every frame, a single soft blurred
 * color blob trails the real cursor with spring-like lag (a duplicate,
 * colored copy of the headline is masked to just that blob), so the color
 * reads as liquid catching up to the pointer rather than lights switching
 * on letter by letter.
 */
export default function GlowHeadline({ text }: { text: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const colorLayer = useRef<HTMLHeadingElement>(null);
  const pos = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    let raf = 0;
    const loop = (time: number) => {
      const box = wrap.current?.getBoundingClientRect();
      if (box) {
        const targetX = pointer.active ? pointer.x - box.left : -9999;
        const targetY = pointer.active ? pointer.y - box.top : -9999;
        pos.current.x += (targetX - pos.current.x) * EASE;
        pos.current.y += (targetY - pos.current.y) * EASE;

        const hue = (time % HUE_PERIOD) / HUE_PERIOD * 360;
        const node = colorLayer.current;
        if (node) {
          node.style.setProperty("--hue", hue.toFixed(1));
          node.style.setProperty("--lx", `${pos.current.x.toFixed(1)}px`);
          node.style.setProperty("--ly", `${pos.current.y.toFixed(1)}px`);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={wrap} className={styles.wrap} style={{ ["--radius" as string]: `${RADIUS}px` }}>
      <h1 className={styles.headline}>{text}</h1>
      <h1 ref={colorLayer} className={`${styles.headline} ${styles.colorLayer}`} aria-hidden="true">
        {text}
      </h1>
    </div>
  );
}
