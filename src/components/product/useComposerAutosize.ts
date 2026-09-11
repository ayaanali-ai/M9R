"use client";

import { useEffect, type RefObject } from "react";

/** Grow to the content, then scroll internally at the CSS height limit. */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, surfaceKey: string) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let lastWidth = -1;
    const resize = () => {
      const styles = getComputedStyle(element);
      const minimum = parseFloat(styles.minHeight) || 48;
      const maximum = parseFloat(styles.maxHeight) || 240;
      element.style.height = "0px";
      element.style.height = `${Math.min(maximum, Math.max(minimum, element.scrollHeight))}px`;
    };
    resize();
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ref, value, surfaceKey]);
}
