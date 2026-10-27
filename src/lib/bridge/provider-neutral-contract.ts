import type { InteractiveProviderAdapter } from "./interactive-provider-adapter";

/**
 * Runtime guard for the shared provider boundary.
 *
 * Provider-specific adapters are allowed to translate their own wire format,
 * but they may not remove a lifecycle operation from the bridge surface or
 * introduce a second provider-specific workflow.  Keeping this check at the
 * registry boundary means a future provider fails at registration with a
 * useful diagnostic instead of failing later after a task is delivered.
 */
export const PROVIDER_NEUTRAL_INTERACTIVE_ADAPTER_METHODS = [
  "discoverCapabilities",
  "launchServer",
  "initialize",
  "createSession",
  "resumeSession",
  "prompt",
  "cancelTurn",
  "respondToPermission",
  "closeSession",
  "shutdown",
] as const;

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function providerNeutralAdapterConformanceErrors(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["adapter must be an object"];
  }

  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof candidate.id !== "string" || !ADAPTER_ID_PATTERN.test(candidate.id)) {
    errors.push("id must be a lowercase provider adapter slug");
  }
  for (const method of PROVIDER_NEUTRAL_INTERACTIVE_ADAPTER_METHODS) {
    if (typeof candidate[method] !== "function") errors.push(`missing ${method}()`);
  }
  return errors;
}

export function assertProviderNeutralInteractiveAdapter(value: unknown): asserts value is InteractiveProviderAdapter {
  const errors = providerNeutralAdapterConformanceErrors(value);
  if (errors.length === 0) return;
  const id = value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? ` '${(value as { id: string }).id}'`
    : "";
  throw new Error(`Provider adapter${id} is not provider-neutral: ${errors.join("; ")}.`);
}
