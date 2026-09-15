"use client";

import { useEffect, useRef } from "react";
import { pointer } from "./pointer";
import styles from "./Cursor.module.css";

/** A plain dot standing in for the system cursor -- the Pony Studio mechanic. */
export default function Cursor() {
  const dot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const node = dot.current;
      if (node) {
        node.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
        node.style.opacity = pointer.active ? "1" : "0";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div ref={dot} className={styles.dot} aria-hidden="true" />;
}
