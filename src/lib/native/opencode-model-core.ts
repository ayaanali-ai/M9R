import { join } from "node:path";

/**
 * Catalog-driven OpenCode model selection and persisted-state repair.
 *
 * OpenCode stores recent/favorite model references separately from its live
 * provider catalog. A model can therefore remain in model.json after the
 * provider has deprecated or removed it. This module deliberately treats an
 * unavailable catalog as a no-op: repairing user state from a guessed model
 * is worse than leaving it untouched and reporting the blocked repair.
 */

export interface OpenCodeModelSelection {
  providerID: string;
  modelID: string;
}

interface ModelDescriptor extends OpenCodeModelSelection {
  status?: string;
}

export interface OpenCodeModelRepairResult {
  status: "updated" | "unchanged" | "blocked";
  reason: string;
  state?: Record<string, unknown>;
  selection?: OpenCodeModelSelection;
  removedModelIDs: string[];
}

export function resolveOpenCodeModelFiles(input: {
  home: string;
  xdgStateHome?: string;
  xdgCacheHome?: string;
}): { statePath: string; catalogPath: string } {
  const stateHome = input.xdgStateHome?.trim() || join(input.home, ".local", "state");
  const cacheHome = input.xdgCacheHome?.trim() || join(input.home, ".cache");
  return {
    statePath: join(stateHome, "opencode", "model.json"),
    catalogPath: join(cacheHome, "opencode", "models.json"),
  };
}
const UNUSABLE_STATUSES = new Set(["deprecated", "disabled", "unavailable", "removed"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function providerID(value: Record<string, unknown>): string | undefined {
  return text(value.providerID) ?? text(value.providerId) ?? text(value.id);
}

function modelID(value: Record<string, unknown>, fallback?: string): string | undefined {
  const candidate = text(value.modelID) ?? text(value.modelId) ?? text(value.id) ?? fallback;
  if (!candidate) return undefined;
  const slash = candidate.indexOf("/");
  return slash > 0 ? candidate.slice(slash + 1) : candidate;
}

function unusable(status: unknown): boolean {
  const normalized = text(status)?.toLowerCase();
  return normalized !== undefined && UNUSABLE_STATUSES.has(normalized);
}

function unwrapCatalog(raw: unknown): Record<string, unknown> | null {
  const root = record(raw);
  if (!root) return null;
  return record(root.data) ?? root;
}

function descriptorsForProvider(raw: unknown, wantedProvider: string): { models: ModelDescriptor[]; defaultModelID?: string } | null {
  const root = unwrapCatalog(raw);
  if (!root) return null;
  const providers = Array.isArray(root.providers) ? root.providers : [];
  let provider = providers.map(record).find((candidate) => candidate && providerID(candidate) === wantedProvider) ?? null;
  // OpenCode's persisted cache is provider-keyed, unlike the SDK response
  // returned by config.providers(). Accept both real shapes so setup can
  // repair model.json from the cache without inventing a model.
  if (!provider) {
    const cachedProvider = record(root[wantedProvider]);
    if (cachedProvider) provider = cachedProvider;
  }
  if (!provider) return null;

  const models: ModelDescriptor[] = [];
  if (Array.isArray(provider.models)) {
    for (const candidate of provider.models) {
      const item = record(candidate);
      const id = item ? modelID(item) : undefined;
      if (id) models.push({ providerID: wantedProvider, modelID: id, ...(item && text(item.status) ? { status: text(item.status) } : {}) });
    }
  } else if (record(provider.models)) {
    const providerModels = record(provider.models)!;
    for (const [key, value] of Object.entries(providerModels)) {
      const item = record(value) ?? {};
      const id = modelID(item, key);
      if (id) models.push({ providerID: wantedProvider, modelID: id, ...(text(item.status) ? { status: text(item.status) } : {}) });
    }
  }

  const defaults = record(root.default);
  const defaultValue = provider.default ?? provider.defaultModel ?? defaults?.[wantedProvider];
  const defaultRecord = record(defaultValue);
  const defaultModelID = defaultRecord ? modelID(defaultRecord) : text(defaultValue);
  return { models, ...(defaultModelID ? { defaultModelID: modelID({ id: defaultModelID }) } : {}) };
}

function usableModels(raw: unknown, wantedProvider: string): { models: ModelDescriptor[]; defaultModelID?: string } | null {
  const catalog = descriptorsForProvider(raw, wantedProvider);
  if (!catalog) return null;
  const models = catalog.models.filter((candidate) => !unusable(candidate.status));
  return { models, ...(catalog.defaultModelID ? { defaultModelID: catalog.defaultModelID } : {}) };
}

/** Select a currently usable model from an OpenCode config.providers response. */
export function chooseOpenCodeModel(raw: unknown, wantedProvider = "opencode"): OpenCodeModelSelection | null {
  const catalog = usableModels(raw, wantedProvider);
  if (!catalog || catalog.models.length === 0) return null;
  const preferred = catalog.defaultModelID && catalog.models.some((candidate) => candidate.modelID === catalog.defaultModelID)
    ? catalog.defaultModelID
    : [...catalog.models].sort((left, right) => left.modelID.localeCompare(right.modelID))[0]?.modelID;
  return preferred ? { providerID: wantedProvider, modelID: preferred } : null;
}

/**
 * Self-contained selector used inside the generated OpenCode plugin. Keep
 * this function free of module-level helpers because its source is embedded
 * into a user-owned plugin file at setup time.
 */
export function chooseOpenCodeModelFromCatalog(raw: unknown, wantedProvider = "opencode"): OpenCodeModelSelection | null {
  function object(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }
  function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  const root = object(raw);
  const data = root ? object(root.data) ?? root : null;
  const providers = data && Array.isArray(data.providers) ? data.providers : [];
  let provider: Record<string, unknown> | null = null;
  for (const candidate of providers) {
    const item = object(candidate);
    if (item && (stringValue(item.id) ?? stringValue(item.providerID) ?? stringValue(item.providerId)) === wantedProvider) {
      provider = item;
      break;
    }
  }
  if (!provider && data) provider = object(data[wantedProvider]);
  if (!provider) return null;
  const unusableStatuses = new Set(["deprecated", "disabled", "unavailable", "removed"]);
  const models: Array<{ modelID: string; status?: string }> = [];
  const source = provider.models;
  function add(candidate: unknown, fallback?: string): void {
    const item = object(candidate) ?? {};
    const rawID = stringValue(item.modelID) ?? stringValue(item.modelId) ?? stringValue(item.id) ?? fallback;
    if (!rawID) return;
    const modelID = rawID.includes("/") ? rawID.slice(rawID.indexOf("/") + 1) : rawID;
    const status = stringValue(item.status)?.toLowerCase();
    if (!status || !unusableStatuses.has(status)) models.push({ modelID, ...(status ? { status } : {}) });
  }
  if (Array.isArray(source)) for (const item of source) add(item);
  else if (object(source)) {
    const sourceObject = object(source)!;
    for (const [key, value] of Object.entries(sourceObject)) add(value, key);
  }
  if (models.length === 0) return null;
  const defaults = object(data?.default);
  const defaultValue = provider.default ?? provider.defaultModel ?? defaults?.[wantedProvider];
  const defaultRecord = object(defaultValue);
  const rawDefault = defaultRecord ? stringValue(defaultRecord.modelID) ?? stringValue(defaultRecord.modelId) ?? stringValue(defaultRecord.id) : stringValue(defaultValue);
  const defaultID = rawDefault?.includes("/") ? rawDefault.slice(rawDefault.indexOf("/") + 1) : rawDefault;
  let selected = defaultID && models.some(function (model) { return model.modelID === defaultID; })
    ? defaultID
    : undefined;
  if (!selected) {
    const sorted = models.slice();
    sorted.sort(function (left, right) { return left.modelID.localeCompare(right.modelID); });
    selected = sorted[0]?.modelID;
  }
  return selected ? { providerID: wantedProvider, modelID: selected } : null;
}

function entrySelection(value: unknown): OpenCodeModelSelection | null {
  const item = record(value);
  if (!item) return null;
  const provider = providerID(item);
  const model = modelID(item);
  return provider && model ? { providerID: provider, modelID: model } : null;
}

function sameSelection(left: OpenCodeModelSelection | null, right: OpenCodeModelSelection): boolean {
  return Boolean(left && left.providerID === right.providerID && left.modelID === right.modelID);
}

/**
 * Plan a non-destructive repair of OpenCode's model.json shape. The returned
 * state preserves unrelated providers and unknown top-level fields. Callers
 * must write it atomically and retain a recoverable backup.
 */
export function planOpenCodeModelStateRepair(
  rawState: unknown,
  rawCatalog: unknown,
  wantedProvider = "opencode",
): OpenCodeModelRepairResult {
  const state = record(rawState);
  const catalog = usableModels(rawCatalog, wantedProvider);
  if (!state) return { status: "blocked", reason: "persisted OpenCode model state is not an object", removedModelIDs: [] };
  if (!catalog || catalog.models.length === 0) return { status: "blocked", reason: "the live OpenCode provider catalog is unavailable or has no usable models", removedModelIDs: [] };

  const usable = new Set(catalog.models.map((candidate) => candidate.modelID));
  const removed = new Set<string>();
  const next: Record<string, unknown> = { ...state };
  const filterList = (key: "recent" | "favorite") => {
    const current = state[key];
    if (!Array.isArray(current)) return;
    next[key] = current.filter((candidate) => {
      const selection = entrySelection(candidate);
      if (!selection || selection.providerID !== wantedProvider || usable.has(selection.modelID)) return true;
      removed.add(selection.modelID);
      return false;
    });
  };
  filterList("recent");
  filterList("favorite");

  const variants = record(state.variant);
  if (variants) {
    const nextVariants: Record<string, unknown> = { ...variants };
    for (const key of Object.keys(variants)) {
      if (!key.startsWith(`${wantedProvider}/`)) continue;
      const model = key.slice(wantedProvider.length + 1);
      if (!usable.has(model)) {
        removed.add(model);
        delete nextVariants[key];
      }
    }
    next.variant = nextVariants;
  }

  const recent = Array.isArray(next.recent) ? next.recent : [];
  const currentSelection = recent.map(entrySelection).find((candidate) => candidate?.providerID === wantedProvider && usable.has(candidate.modelID)) ?? null;
  const favoriteSelection = Array.isArray(next.favorite)
    ? next.favorite.map(entrySelection).find((candidate) => candidate?.providerID === wantedProvider && usable.has(candidate.modelID)) ?? null
    : null;
  const selected = currentSelection ?? favoriteSelection ?? chooseOpenCodeModel(rawCatalog, wantedProvider);
  if (!selected) return { status: "blocked", reason: "the live OpenCode provider catalog did not yield a usable model", removedModelIDs: [...removed] };

  const recentHasSelected = recent.some((candidate) => sameSelection(entrySelection(candidate), selected));
  if (!recentHasSelected) next.recent = [{ providerID: selected.providerID, modelID: selected.modelID }, ...recent];

  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return {
    status: changed ? "updated" : "unchanged",
    reason: changed ? "removed unavailable/deprecated model references and selected a live provider model" : "persisted model references already match the live provider catalog",
    state: next,
    selection: selected,
    removedModelIDs: [...removed],
  };
}
