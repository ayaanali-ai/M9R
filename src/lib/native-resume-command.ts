/**
 * The command a person can run in their own terminal to continue a session M9R started, using the
 * provider's own session id. Flags checked against each CLI's --help; null for providers with no
 * known native resume command, so the UI never shows a command that does not exist.
 */
export function nativeResumeCommand(agentKind: string, providerSessionRef: string | null | undefined): string | null {
  const ref = providerSessionRef?.trim();
  if (!ref || !/^[A-Za-z0-9._:-]{1,256}$/.test(ref)) return null;
  switch (agentKind) {
    case "claude-code": return `claude --resume ${ref}`;
    case "codex": return `codex resume ${ref}`;
    case "opencode": return `opencode --session ${ref}`;
    default: return null;
  }
}
