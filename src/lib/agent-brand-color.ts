/**
 * Per-agent brand colors, usable from both React components and plain server-side/lib code.
 * Kept out of WorkspaceUI.tsx (which re-exports it for existing component imports) so a
 * non-React module like agent-color.ts never has to import a .tsx file to reach it.
 *
 * These are M9R's stable provider identity colors for the current demo/release boundary. They are
 * deliberately product-owned rather than claims about vendor branding: Codex is the Balanced blue,
 * Claude keeps its terracotta, and OpenCode uses the Balanced-C soft gray. Unknown providers fall
 * back to the neutral text color until a later palette/customization pass assigns them explicitly.
 */
export const AGENT_BRAND_COLOR: Partial<Record<string, string>> = {
  "claude-code": "#D97757",
  codex: "#4F7CFF",
  opencode: "#9CA3AF",
};
