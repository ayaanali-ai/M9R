"use client";

import { useEffect, useState } from "react";
import { LiquidMetal } from "@paper-design/shaders-react";

/**
 * M9R's own liquid-metal control -- NOT the raw 21st.dev LiquidMetalButton.
 * That vendor source is fixed at 142x46px, 14px/#666666 label text, and a
 * 4-layer shadow stack tuned for its own demo page; dropping it into any
 * M9R surface clashes on every dimension against this app's real metrics
 * (36px controls, 12-13px type, hairline elevation). Confirmed live on the
 * Memory page -- this is the fix for that.
 *
 * Built directly on LiquidMetal (@paper-design/shaders-react), the same
 * primitive M9RLiquidMark.tsx already uses for the homepage's hero mark,
 * with the same colorTint (#c99bff) -- so this reads as the same material
 * as the homepage, not a lookalike invented for the dashboard.
 *
 * Per the design spec: this is the ONE chrome moment per screen. Do not
 * reach for this for a second control on the same view -- if it feels like
 * you need two, one of them is wrong.
 */
export interface ChromeButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Swaps the material to the warn tint for a live/in-progress state (e.g. Stop). */
  tone?: "chrome" | "warn";
  "aria-label"?: string;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}

const TONE_TINT: Record<NonNullable<ChromeButtonProps["tone"]>, string> = {
  chrome: "#c99bff",
  warn: "#e0b45a",
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ));
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

export function ChromeButton({ children, onClick, disabled, tone = "chrome", type = "button", className, ...aria }: ChromeButtonProps) {
  const [hovered, setHovered] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`m9r-chrome-btn ${className ?? ""}`.trim()}
      data-disabled={disabled || undefined}
      data-reduced-motion={reducedMotion || undefined}
      data-tone={tone}
      {...aria}
    >
      {!reducedMotion && !disabled && (
        <LiquidMetal
          className="m9r-chrome-btn__shader"
          colorBack="#00000000"
          colorTint={TONE_TINT[tone]}
          shape="none"
          repetition={4}
          softness={0.45}
          shiftRed={0.3}
          shiftBlue={0.35}
          distortion={0.05}
          contour={0.3}
          angle={55}
          speed={hovered ? 1 : 0.5}
          fit="cover"
        />
      )}
      <span className="m9r-chrome-btn__content">{children}</span>
    </button>
  );
}
