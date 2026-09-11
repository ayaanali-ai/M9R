/**
 * Preset Workspace Rules — a curated starter set a workspace owner can
 * enable with one click, instead of writing rules from scratch.
 *
 * Delivery is unchanged from every other workspace rule: an agent receives
 * these as advisory text (via `npx m9r-cli rules` for terminal/CLI sessions,
 * or fed directly for workspace/chat sessions -- see bridge-runtime.ts). No
 * rule's content can trigger a hard approval gate today (see
 * agent-preflight-service.ts) -- that would be a separate, materially larger
 * project. What IS real here: phrasing each preset with the same imperative,
 * explicit-trigger structure that already makes MANDATORY_REPORT_INSTRUCTION
 * work reliably in practice, instead of soft advisory prose.
 */

export interface WorkspaceRulePreset {
  id: string;
  title: string;
  body: string;
}

export const WORKSPACE_RULE_PRESETS: readonly WorkspaceRulePreset[] = [
  {
    id: "no-hallucinated-claims",
    title: "No hallucinated claims",
    body: "Never state a file exists, a function behaves a certain way, or a command produced output you did not directly observe in this session. If you have not read it or run it, say so explicitly instead of guessing.",
  },
  {
    id: "no-silent-assumptions",
    title: "No silent assumptions",
    body: "When a request is ambiguous or missing information you need, ask a specific question or state your assumption explicitly before acting on it. Do not silently pick an interpretation and proceed as if it were the only one.",
  },
  {
    id: "no-blind-retries",
    title: "No blind retries",
    body: "If a command or approach fails, do not rerun it unchanged expecting a different result. Diagnose the actual error first, change something concrete based on that diagnosis, then retry.",
  },
  {
    id: "no-overclaiming",
    title: "No overclaiming",
    body: "Report exactly what you did, found, or verified -- no more. Never claim something is \"done\", \"fixed\", or \"working\" unless you observed it working. Do not use hype language to make incomplete work sound complete.",
  },
] as const;
