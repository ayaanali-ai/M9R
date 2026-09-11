/**
 * Deterministic per-identity avatar color/initials — shared between the real
 * Watchfloor chat (ConversationPanel.tsx) and the homepage's live-product
 * preview (HeroChatPreview.tsx), so the marketing page's illustrative
 * avatars use the exact same coloring the real product does, not a
 * lookalike approximation that could visibly drift from it over time.
 */

/** Hue (0-360) so the same sender always renders the same avatar color across messages, sessions, and reloads. */
export function identityHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return hash % 360;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
