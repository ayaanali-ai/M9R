/**
 * Provider-reported model capability data.  This module is deliberately pure:
 * it does not read provider config, start a process, or guess a model name.
 * Adapters feed it only the catalog they received from the live provider.
 */

export interface ProviderModelEffort {
  readonly id: string;
  readonly label: string;
}

export interface ProviderModelOption {
  readonly id: string;
  readonly label: string;
  /** `null` means the provider did not report an effort catalog. */
  readonly efforts?: readonly ProviderModelEffort[] | null;
  /** The provider's own one-line description, when it reports one. */
  readonly description?: string;
}

export interface ProviderModelSelection {
  readonly model?: string | null;
  readonly effort?: string | null;
}

export interface ProviderModelCapabilities {
  readonly connectionId: string;
  readonly provider: string;
  readonly generation: number;
  /** Null means this provider/session does not expose a live catalog. */
  readonly models: readonly ProviderModelOption[] | null;
  readonly currentModel?: string | null;
  readonly currentEffort?: string | null;
}

export type ProviderModelSelectionValidation =
  | { readonly ok: true; readonly selection: ProviderModelSelection }
  | { readonly ok: false; readonly reason: string };

const MAX_MODELS = 64;
const MAX_EFFORTS = 32;
const MAX_ID = 160;
const MAX_LABEL = 240;

function safeText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate a provider catalog without inventing or silently repairing it. */
export function validateProviderModelCatalog(raw: unknown): readonly ProviderModelOption[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MODELS) return null;
  const models: ProviderModelOption[] = [];
  const modelIds = new Set<string>();
  for (const value of raw) {
    const record = objectRecord(value);
    const id = safeText(record?.id, MAX_ID);
    const label = safeText(record?.label, MAX_LABEL);
    if (!id || !label || modelIds.has(id)) return null;
    modelIds.add(id);
    const rawEfforts = record?.efforts;
    let efforts: readonly ProviderModelEffort[] | null | undefined;
    if (rawEfforts === null || rawEfforts === undefined) efforts = null;
    else {
      if (!Array.isArray(rawEfforts) || rawEfforts.length > MAX_EFFORTS) return null;
      const normalized: ProviderModelEffort[] = [];
      const effortIds = new Set<string>();
      for (const effortValue of rawEfforts) {
        const effort = objectRecord(effortValue);
        const effortId = safeText(effort?.id, MAX_ID);
        const effortLabel = safeText(effort?.label, MAX_LABEL);
        if (!effortId || !effortLabel || effortIds.has(effortId)) return null;
        effortIds.add(effortId);
        normalized.push({ id: effortId, label: effortLabel });
      }
      efforts = normalized;
    }
    // Description is optional provider copy: an invalid one is dropped, never repaired.
    const description = safeText(record?.description, MAX_LABEL);
    models.push({ id, label, efforts, ...(description ? { description } : {}) });
  }
  return models;
}

function normalizeSelection(selection: ProviderModelSelection): ProviderModelSelection {
  const model = typeof selection.model === "string" ? selection.model.trim() : undefined;
  const effort = typeof selection.effort === "string" ? selection.effort.trim() : undefined;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Validate a requested selection against the exact catalog returned by the
 * provider. A non-null model cannot be accepted when the provider did not
 * expose a catalog; this is the guard against hard-coded/guessed model names.
 */
export function validateProviderModelSelection(
  capabilities: Pick<ProviderModelCapabilities, "models" | "currentModel">,
  requested: ProviderModelSelection,
): ProviderModelSelectionValidation {
  const selection = normalizeSelection(requested);
  if (!selection.model && selection.effort) {
    return { ok: false, reason: "an effort requires an explicitly selected model" };
  }
  if (!selection.model) return { ok: true, selection };
  if (capabilities.models === null) {
    return { ok: false, reason: "the provider did not expose a live model catalog" };
  }
  const model = capabilities.models.find((option) => option.id === selection.model);
  if (!model) return { ok: false, reason: `the provider did not report model ${JSON.stringify(selection.model)}` };
  if (selection.effort) {
    if (!model.efforts) return { ok: false, reason: `the provider did not expose effort choices for model ${JSON.stringify(model.id)}` };
    if (!model.efforts.some((effort) => effort.id === selection.effort)) {
      return { ok: false, reason: `the provider did not report effort ${JSON.stringify(selection.effort)} for model ${JSON.stringify(model.id)}` };
    }
  }
  return { ok: true, selection };
}
