/**
 * Available Model Options — validation for a connection's self-reported,
 * real ACP model list (agent_connections.available_models).
 *
 * Pure, network-free -- kept separate from callsign-service.ts (which pulls
 * in the Supabase server client, and transitively next/headers) so this can
 * be imported and unit-tested outside the Next.js runtime, mirroring
 * capability-card.ts's role for Capability Card declarations.
 */

export interface AvailableModelOption {
  id: string;
  label: string;
}

const MAX_AVAILABLE_MODELS = 64;

export function validateAvailableModels(raw: unknown): { ok: true; normalized: AvailableModelOption[] | null } | { ok: false; errors: string[] } {
  if (raw === null) return { ok: true, normalized: null };
  if (!Array.isArray(raw)) return { ok: false, errors: ["available_models must be an array or null."] };
  if (raw.length > MAX_AVAILABLE_MODELS) return { ok: false, errors: [`available_models exceeds ${MAX_AVAILABLE_MODELS} entries.`] };
  const normalized: AvailableModelOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, errors: ["Each model entry must be an object with id and label."] };
    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim() || id.length > 80) return { ok: false, errors: ["Each model entry needs a non-empty id (max 80 chars)."] };
    if (typeof label !== "string" || !label.trim() || label.length > 120) return { ok: false, errors: ["Each model entry needs a non-empty label (max 120 chars)."] };
    normalized.push({ id: id.trim(), label: label.trim() });
  }
  return { ok: true, normalized: normalized.length > 0 ? normalized : null };
}
