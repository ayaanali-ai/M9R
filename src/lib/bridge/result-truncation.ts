/** A channel message body is capped at 2,000 characters. */
export const WORKSPACE_RESULT_MAX_CHARS = 2_000;

/**
 * A reply longer than the channel limit used to be cut mid-sentence with nothing to say so, which reads as the agent
 * stopping for no reason. Keep as much as fits and end with an explicit marker saying how much was left out.
 */
export function truncateWorkspaceResult(body: string, max: number = WORKSPACE_RESULT_MAX_CHARS): string {
  if (body.length <= max) return body;
  let kept = max;
  let marker = "";
  // The marker's own length depends on the omitted count, so settle it in a couple of passes.
  for (let i = 0; i < 3; i += 1) {
    marker = `\n\n… [reply truncated: ${body.length - kept} more characters not shown]`;
    kept = Math.max(0, max - marker.length);
  }
  marker = `\n\n… [reply truncated: ${body.length - kept} more characters not shown]`;
  return `${body.slice(0, kept)}${marker}`.slice(0, max);
}
