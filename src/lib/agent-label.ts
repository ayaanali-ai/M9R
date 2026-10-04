/** The proper display name for an agent type, used on the messages that agent sends. */
export function agentLabelFor(agentKind: string): string {
  return agentKind === "claude-code" ? "Claude"
    : agentKind === "codex" ? "Codex"
      : agentKind === "grok-build" ? "Grok Build"
        : agentKind === "opencode" ? "OpenCode"
          : agentKind === "antigravity" ? "Antigravity"
            // Any other provider: its own name with capitals, never a raw id like "some-agent".
            : agentKind.split(/[-_\s]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "An agent";
}
