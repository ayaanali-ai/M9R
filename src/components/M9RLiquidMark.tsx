"use client";

import { LiquidMetal } from "@paper-design/shaders-react";

/**
 * Real animated holographic mark, built with @paper-design/shaders-react
 * (a genuine WebGL shader library, found via 21st.dev's "Liquid & metal"
 * category, not a hand-rolled CSS approximation) -- pours an animated
 * liquid-metal material into the shard shape (public/m9r-shard.svg, a
 * transparent-background mask, per the component's own required input
 * shape). Promoted to the homepage's own animated mark per explicit
 * direction, the flat monochrome M9RMark stays the default logo everywhere
 * else (nav, favicon, dashboard).
 */
export default function M9RLiquidMark({
  width = 260,
  height = 260,
  className = "",
  colorTint = "#c99bff",
}: {
  width?: number;
  height?: number;
  className?: string;
  colorTint?: string;
}) {
  return (
    <LiquidMetal
      className={className}
      width={width}
      height={height}
      image="/m9r-shard.svg"
      colorBack="#00000000"
      colorTint={colorTint}
      shape="none"
      repetition={3}
      softness={0.35}
      shiftRed={0.3}
      shiftBlue={0.4}
      distortion={0.08}
      contour={0.5}
      angle={70}
      speed={0.6}
      scale={0.85}
      fit="contain"
    />
  );
}
