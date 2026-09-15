"use client";

import { useCallback, useRef, useState } from "react";
import styles from "./NavPill.module.css";

/**
 * Nothing on this pill is ever persistently "selected" -- all three open an
 * in-page panel over the dulled homepage rather than navigating away -- so
 * the morphing indicator is a hover-follow: it glides to whatever the
 * pointer is over and fades out when the pointer leaves the pill.
 */
export default function NavPill({
  onPricing,
  onMemo,
  onSignIn,
}: {
  onPricing: () => void;
  onMemo: () => void;
  onSignIn: () => void;
}) {
  const pill = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);

  const follow = useCallback((event: React.PointerEvent | React.FocusEvent) => {
    const target = event.target as HTMLElement;
    const segment = target.closest<HTMLElement>("[data-seg]");
    if (!segment || !pill.current) return;
    const outer = pill.current.getBoundingClientRect();
    const inner = segment.getBoundingClientRect();
    setBox({ x: inner.left - outer.left, w: inner.width });
  }, []);

  return (
    <nav
      ref={pill}
      className={styles.pill}
      aria-label="Main navigation"
      onPointerMove={follow}
      onPointerLeave={() => setBox(null)}
      onFocus={follow}
      onBlur={() => setBox(null)}
    >
      <span
        className={styles.indicator}
        aria-hidden="true"
        data-on={box ? "true" : "false"}
        style={box ? { transform: `translateX(${box.x}px)`, width: `${box.w}px` } : undefined}
      />
      <button type="button" data-seg onClick={onPricing}>Pricing</button>
      <span className={styles.rule} aria-hidden="true" />
      <button type="button" data-seg onClick={onMemo}>Memo</button>
      <span className={styles.rule} aria-hidden="true" />
      <button type="button" data-seg onClick={onSignIn}>Sign in</button>
    </nav>
  );
}
