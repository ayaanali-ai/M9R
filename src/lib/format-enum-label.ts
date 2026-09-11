/**
 * Turns a raw snake_case enum/status value into a human-readable label (e.g.
 * "needs_follow_up" -> "needs follow up"). The one shared humanizer so new
 * render sites reuse this instead of each reinventing (and potentially
 * diverging from) the same replaceAll/toLowerCase pattern.
 */
export function humanizeEnumLabel(value: string): string {
  return value.replaceAll("_", " ").toLowerCase();
}
