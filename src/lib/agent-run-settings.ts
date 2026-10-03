import type { AvailableModelOption } from "./available-model-options";

export interface AgentRunSettings { model: string | null; effort: string | null }
export interface AgentRunOptions { models: AvailableModelOption[] | null; efforts: AvailableModelOption[] | null }

/** Unknown model support must not inherit another model's effort choices. */
export function effortsForModel(options: AgentRunOptions, model: string | null): AvailableModelOption[] | null {
  return model === null ? options.efforts : options.models?.find(option => option.id === model)?.efforts ?? null;
}

/** Values must come from this connection's provider, never another provider's catalog. */
export function validateRunSettings(raw: unknown, options: AgentRunOptions): AgentRunSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Settings must be an object.");
  const body = raw as Record<string, unknown>;
  const read = (key: "model" | "effort", choices: AvailableModelOption[] | null): string | null => {
    const value = body[key];
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${key} must be a provider option or null.`);
    const selected = value.trim();
    if (!choices?.some(option => option.id === selected)) throw new Error(`This agent has not reported support for ${key} "${selected}".`);
    return selected;
  };
  const model = read("model", options.models);
  return { model, effort: read("effort", effortsForModel(options, model)) };
}

/** A channel may explicitly use provider defaults (null) or inherit connection settings (no override). */
export function effectiveRunSettings(defaults: AgentRunSettings, override?: AgentRunSettings | null): AgentRunSettings {
  return override ? { ...override } : { ...defaults };
}
