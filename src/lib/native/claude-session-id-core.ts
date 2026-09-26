/** Keep Claude resume identifiers safe as one CLI argument (no options or control characters). */
export function validateClaudeResumeSessionId(sessionId: string): string {
  if (!sessionId.trim() || sessionId !== sessionId.trim() || sessionId.length > 256 || sessionId.startsWith("-") || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error("Claude resume session id is invalid.");
  }
  return sessionId;
}
