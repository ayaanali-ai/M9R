/**
 * M9RMark — the shard mark, locked after three rounds of concepts this
 * session. Two overlapping polygons (outer shard, inner facet) reading as an
 * impact frozen mid-fracture; monochrome only, no accent color, matching the
 * product's own no-chromatic-accent decision. `animated` drives a slow
 * 6s drift + 3s inner-facet pulse (CSS, honors prefers-reduced-motion) --
 * deliberately slow so it reads as "alive" without competing for attention.
 * The holographic gradient variant explored alongside this is a separate,
 * one-off personal/social asset, not part of the product's own visual system.
 */

import styles from "./M9RMark.module.css";

export default function M9RMark({
  className = "",
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      className={`${styles.mark} ${animated ? styles.animated : ""} ${className}`.trim()}
      viewBox="0 0 200 200"
      role="img"
      aria-label="M9R"
    >
      <polygon
        points="100,20 118,72 168,60 128,96 158,138 108,120 100,180 88,122 40,140 74,98 32,64 84,74"
        fill="currentColor"
      />
      <polygon
        className={animated ? styles.facet : undefined}
        points="100,45 110,80 145,72 118,98 138,128 106,114 100,155 92,116 58,128 80,100 52,76 88,84"
        fill="var(--m9r-mark-bg, var(--premium-black, #08080a))"
      />
    </svg>
  );
}
