"use client";

/**
 * ScrollReveal — a hydration-safe scroll-reveal enabler for `.lp-reveal`.
 * ----------------------------------------------------------------------------
 * `.lp-reveal` starts at `opacity: 0` in the sheet, so it MUST be revealed by
 * something guaranteed to run — otherwise no-JS or a hydration failure leaves
 * content invisible. This component:
 *
 *   1. Adds `lp-js` to <html> on mount. The paired CSS only hides `.lp-reveal`
 *      while `.lp-js` is present, so with JS off (or before hydration) the
 *      content is fully visible — a true progressive-enhancement fallback.
 *   2. Honours `prefers-reduced-motion`: reveals everything immediately, no
 *      transition, no observer.
 *   3. Otherwise observes each `.lp-reveal` and adds `.lp-in` as it enters view.
 *
 * Render it once per page (it observes the whole document).
 */

import { useEffect } from "react";

export default function ScrollReveal() {
  useEffect(() => {
    const root = document.documentElement;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".lp-reveal"));

    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // With reduced motion (or no IntersectionObserver support), reveal all and
    // never arm the hide rule.
    if (reduce || typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("lp-in"));
      return;
    }

    // Arm the hide rule only now that we can guarantee a reveal path.
    root.classList.add("lp-js");

    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("lp-in");
            obs.unobserve(entry.target);
          }
        }
      },
      // Huge top margin: anything at or above the viewport counts as seen, so
      // instant jumps (anchors, back-button restore) never leave content hidden.
      { threshold: 0.12, rootMargin: "10000px 0px -8% 0px" }
    );

    // Reveal anything already in view (or above the fold) on first paint so the
    // hero never sits blank.
    nodes.forEach((n) => {
      const rect = n.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.92) n.classList.add("lp-in");
      else io.observe(n);
    });

    return () => {
      io.disconnect();
      root.classList.remove("lp-js");
    };
  }, []);

  return null;
}
