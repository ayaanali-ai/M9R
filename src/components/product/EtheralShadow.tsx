"use client";

import { useEffect, useId, useRef } from "react";
import { animate } from "motion";
import { useReducedMotion } from "motion/react";

/** Adapted from Jatin Yadav's Etheral Shadow, unlocked on 21st.dev.
 * https://21st.dev/@jatin-yadav05/components/etheral-shadow
 * Keeps its mask/displacement treatment, fixes the filter forward reference,
 * removes demo content and pauses decorative animation in hidden tabs.
 */
export default function EtheralShadow() {
  const id = `m9r-shadow-${useId().replace(/:/g, "")}`;
  const matrix = useRef<SVGFEColorMatrixElement>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) return;
    const controls = animate(0, 360, {
      duration: 24, repeat: Infinity, ease: "linear",
      onUpdate: value => matrix.current?.setAttribute("values", String(value)),
    });
    const visibility = () => document.hidden ? controls.pause() : controls.play();
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { controls.stop(); document.removeEventListener("visibilitychange", visibility); };
  }, [reducedMotion]);
  return <div className="m9r-etheral-shadow" aria-hidden="true">
    <svg width="0" height="0" focusable="false"><defs>
      <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence result="undulation" numOctaves="2" baseFrequency="0.0005,0.002" seed="0" type="turbulence" />
        <feColorMatrix ref={matrix} in="undulation" type="hueRotate" values="180" result="rotated" />
        <feColorMatrix in="rotated" result="circulation" type="matrix" values="4 0 0 0 1  4 0 0 0 1  4 0 0 0 1  1 0 0 0 0" />
        <feDisplacementMap in="SourceGraphic" in2="circulation" scale="100" result="dist" />
        <feDisplacementMap in="dist" in2="undulation" scale="100" />
      </filter>
    </defs></svg>
    <div className="m9r-etheral-shadow__distortion" style={{ filter: `url(#${id}) blur(4px)` }}><div className="m9r-etheral-shadow__mask" /></div>
    <div className="m9r-etheral-shadow__grain" />
  </div>;
}
