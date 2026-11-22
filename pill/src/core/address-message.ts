/** Explicit @addresses pass through to the broker, including its unknown-handle checks. */
export function addressMessage(draft: string, selected: readonly string[]): string {
  const body = draft.trim();
  if (!body || !selected.length || /(^|\s)@[A-Za-z0-9-]/.test(body)) return body;
  return [...new Set(selected)].map(name => "@" + name).join(" ") + " " + body;
}
