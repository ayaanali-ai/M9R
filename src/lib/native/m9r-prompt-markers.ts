/**
 * Machine-readable boundaries for prompts M9R generated on behalf of a
 * workspace/provider session.  This marker is intentionally provider-neutral:
 * the bridge and the local hook must make the same provenance decision without
 * parsing provider-specific prose.
 */
export const M9R_WORKSPACE_ENVELOPE_MARKER = "[M9R generated workspace envelope v1]";

export function isM9rWorkspaceEnvelope(prompt: string): boolean {
  return prompt.includes(M9R_WORKSPACE_ENVELOPE_MARKER);
}
