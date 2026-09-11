/**
 * AmbientBackground — calm, serious motion behind the whole product.
 *
 * Inspired by high-end defense/industrial sites (Anduril): no flashy glow,
 * no particle confetti. Just three quiet layers that drift slowly enough to
 * feel alive without ever pulling focus:
 *
 *   1. A fine technical grid, masked to fade at the edges.
 *   2. Two large, heavily-blurred accent fields that breathe in/out.
 *   3. A slow vertical scan sweep — a single faint line of light.
 *
 * This is a server component (pure CSS, no JS) so it adds zero hydration
 * cost. All motion is paused under `prefers-reduced-motion`. Styles live in
 * globals.css under the `.ambient*` namespace.
 */
export default function AmbientBackground() {
  return (
    <div className="ambient" aria-hidden="true">
      <div className="ambient-grid" />
      <div className="ambient-field ambient-field-a" />
      <div className="ambient-field ambient-field-b" />
      <div className="ambient-scan" />
      <div className="ambient-vignette" />
    </div>
  );
}
