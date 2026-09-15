"use client";

import { useCallback, useRef, type PointerEvent, type ReactNode } from "react";
import styles from "./MagneticButton.module.css";

/** Cursor proximity (px from the button's edge) at which the pull starts. */
const CATCH = 46;

/**
 * Wraps a button/link so it leans toward an approaching cursor (magnetic
 * pull) and compresses on press (squish). Both effects are transform-only,
 * so they compose with each other without fighting.
 */
export default function MagneticButton({
  as: As = "button",
  className = "",
  children,
  ...rest
}: {
  as?: "button" | "a";
  className?: string;
  children: ReactNode;
  [key: string]: unknown;
}) {
  const node = useRef<HTMLElement>(null);

  const move = useCallback((event: PointerEvent<HTMLElement>) => {
    const el = node.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const reach = Math.max(box.width, box.height) / 2 + CATCH;
    const pull = Math.max(0, 1 - dist / reach);
    el.style.setProperty("--mx", `${(dx * 0.35 * pull).toFixed(1)}px`);
    el.style.setProperty("--my", `${(dy * 0.35 * pull).toFixed(1)}px`);
    el.style.setProperty("--pull", `${Math.min(pull, 1).toFixed(2)}`);
  }, []);

  const reset = useCallback(() => {
    const el = node.current;
    if (!el) return;
    el.style.setProperty("--mx", "0px");
    el.style.setProperty("--my", "0px");
    el.style.setProperty("--pull", "0");
  }, []);

  return (
    <As
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref={node as any}
      className={`${styles.magnetic} ${className}`.trim()}
      style={{ ["--mx" as string]: "0px", ["--my" as string]: "0px", ["--pull" as string]: "0" }}
      onPointerMove={move}
      onPointerLeave={reset}
      {...rest}
    >
      <span className={styles.inner}>{children}</span>
    </As>
  );
}
