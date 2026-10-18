/**
 * Per-agent brand colors, usable from both React components and plain server-side/lib code.
 * Kept out of WorkspaceUI.tsx (which re-exports it for existing component imports) so a
 * non-React module like agent-color.ts never has to import a .tsx file to reach it.
 *
 * Anthropic's terracotta is Claude Code's real, current brand color. Neither OpenAI nor x.ai
 * publishes a signature color for Codex/Grok, so those two used to render neutral gray rather
 * than a stale or guessed hex -- but product chose a deliberate identity color for Codex anyway
 * (soft violet) since distinguishing agents at a glance outweighs the no-official-color caution
 * here. OpenCode stays neutral by choice, not by omission.
 */
export const AGENT_BRAND_COLOR: Partial<Record<string, string>> = {
  "claude-code": "#D97757",
  // OpenAI's real Codex/ChatGPT mark color is white/near-black (theme-dependent), not a tinted
  // hue -- matching their actual brand rather than the placeholder violet used before.
  codex: "#F2EFE9",
};
