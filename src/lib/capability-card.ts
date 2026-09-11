/**
 * Capability Card — OathLock V2 Phase 7
 * ----------------------------------------------------------------------------
 * A short list of capabilities an agent DECLARES about itself (e.g.
 * "TypeScript implementation", "Windows verification"). These are
 * declarations, not proven skill ratings — never rendered as a score or
 * ranking (see product guardrail against unsupported leaderboards).
 */

import { looksLikeSourceCode, SECRET_PATTERNS } from "./agent-run-core";
import { containsActiveContent } from "./agent-join";

const MAX_CAPABILITIES = 20;
const MAX_CAPABILITY_LEN = 80;

export interface CapabilityValidationResult {
  ok: boolean;
  errors: string[];
  normalized: string[];
}

export function validateCapabilities(raw: unknown): CapabilityValidationResult {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["capabilities must be an array of short strings."], normalized: [] };
  }

  const errors: string[] = [];
  const items = raw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_CAPABILITIES);

  for (const item of items) {
    if (item.length > MAX_CAPABILITY_LEN) errors.push(`"${item.slice(0, 20)}..." exceeds ${MAX_CAPABILITY_LEN} characters.`);
    if (containsActiveContent(item)) errors.push(`Rejected: active script or markup content in a capability.`);
    if (looksLikeSourceCode(item)) errors.push(`Rejected: raw source code content in a capability.`);
    for (const [pattern] of SECRET_PATTERNS) {
      if (pattern.test(item)) errors.push(`Rejected: secret-shaped content in a capability.`);
      pattern.lastIndex = 0;
    }
  }

  if (errors.length > 0) return { ok: false, errors, normalized: [] };
  return { ok: true, errors: [], normalized: items };
}
