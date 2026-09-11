/**
 * A small, bespoke icon set (design pass 2026-08-21) — deliberately NOT
 * Lucide's default geometry. Shared rules across every icon here so the set
 * reads as one family rather than mixed-provenance glyphs: 20px viewBox,
 * 1.75 stroke (bolder than Lucide's 2px-on-24 default reads at small sizes),
 * round caps/joins, currentColor only (monochrome system — these never
 * carry their own color). Scoped to the composer toolbar for now, the
 * highest-visibility spot in the product; a full app-wide icon pass is a
 * separate, larger follow-up, not rushed into this one.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number) {
  return { width: size, height: size, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
}

export function AttachIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size)} {...props} aria-hidden>
      <path d="M13.5 7.5 8.4 12.6a2.5 2.5 0 0 1-3.54-3.54l6.01-6.01a4 4 0 0 1 5.66 5.66l-6.36 6.36a5.5 5.5 0 0 1-7.78-7.78L9.5 0.29" transform="translate(1 3)" />
    </svg>
  );
}

export function MentionIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size)} {...props} aria-hidden>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M13.4 10v1.3a2.3 2.3 0 0 0 4.6 0V10a8 8 0 1 0-3.2 6.4" />
    </svg>
  );
}

export function SendIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size)} {...props} aria-hidden>
      <path d="M10 15.5V4.5" />
      <path d="M5 9.2 10 4.5l5 4.7" />
    </svg>
  );
}
