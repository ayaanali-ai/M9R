/**
 * M9RHoloMark — the holographic variant of the shard mark, promoted from a
 * one-off personal asset to the homepage's own animated closing visual, per
 * explicit direction. Built as a clip-path div (the same shard polygon,
 * converted to percentage coordinates) with an animated gradient position
 * plus a slow hue-rotate, rather than trying to animate SVG gradient stops
 * directly -- more reliable across browsers, and it's how most holographic-
 * card effects on the web are actually built (a moving gradient behind a
 * clipped shape, not a literally rotating rainbow inside the SVG itself).
 */

import styles from "./M9RHoloMark.module.css";

export default function M9RHoloMark({ className = "" }: { className?: string }) {
  return (
    <div className={`${styles.wrap} ${className}`.trim()} aria-hidden>
      <div className={styles.gradient} />
      <div className={styles.facet} />
      <div className={styles.sheen} />
    </div>
  );
}
