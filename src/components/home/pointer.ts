/**
 * Module-level (not React state) pointer tracker. The cursor dot and the
 * headline's letter-glow both read this every animation frame; routing it
 * through React state would mean a re-render per mousemove.
 */
export const pointer = { x: -9999, y: -9999, active: false };

if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (event) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
    },
    { passive: true }
  );
  window.addEventListener("pointerleave", () => {
    pointer.active = false;
  });
}
