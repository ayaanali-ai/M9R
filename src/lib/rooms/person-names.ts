import { supabase } from "@/lib/supabase";

/** What to call a person: profile name, then username, then the start of their email. Never an id. */
export function personLabel(person: { name?: string | null; username?: string | null; email?: string | null }): string | null {
  return person.name?.trim() || person.username?.trim() || person.email?.split("@")[0]?.trim() || null;
}

/**
 * Names for the people in a room, so teammates are shown as people and not as ids. Only called with ids the caller can already
 * see (admitted members, or the pending requests the host is allowed to review). Missing profiles are simply absent.
 */
export async function personNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds)].slice(0, 200);
  if (ids.length === 0 || !supabase) return names;
  const { data, error } = await supabase.from("users").select("id, name, username, email").in("id", ids);
  if (error) { console.error("Room person names failed:", error.message); return names; }
  for (const person of data ?? []) {
    const label = personLabel(person as { name: string | null; username: string | null; email: string | null });
    if (label) names.set((person as { id: string }).id, label);
  }
  return names;
}
