/**
 * Endpoint-mention detection for the native front door (design: M9R_NATIVE_FRONT_DOOR_DESIGN.md section 3 and 5).
 *
 * Claude Code and Codex already use `@path` for files, and people write emails and scoped package names, so a token
 * counts as an endpoint mention only when it (a) starts a word, (b) is not part of a path, email or package name,
 * (c) exactly matches a registered alias, (d) is not inside code, and (e) does not name an existing file or folder.
 * Pure: the caller passes the alias list and a path-exists check, so it runs the same in a hook and in a test.
 */

/** Same shape the endpoints table enforces for `alias`. */
export const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export interface MentionOptions {
  /** Registered aliases for the caller's owner, lower case, without the `@`. */
  aliases: readonly string[];
  /** True when the token names an existing file or folder relative to the working directory. */
  pathExists?: (token: string) => boolean;
}

function stripCode(text: string): string {
  // Fenced blocks first (they can contain backticks), then inline code. Replace with spaces to keep offsets simple.
  return text
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** Returns each distinct mentioned alias once, in the order first written. */
export function findEndpointMentions(prompt: string, options: MentionOptions): string[] {
  const known = new Set(options.aliases.map((a) => a.toLowerCase()));
  if (known.size === 0) return [];
  const text = stripCode(prompt);
  // Preceded by start or a separator (so `a@b.com` and `x@codex` never match); followed by end, whitespace or trailing
  // punctuation (so `@codex.` matches but `@codex/file.ts` and `@codex.js` do not).
  const re = /(^|[\s(\["'])@([A-Za-z0-9][A-Za-z0-9-]{0,37})(?=$|[\s,:;!?)\]"']|\.(?=$|\s))/g;
  const found: string[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const token = m[2].toLowerCase();
    if (!ALIAS_PATTERN.test(token) || !known.has(token) || found.includes(token)) continue;
    if (options.pathExists?.(token)) continue;
    found.push(token);
  }
  return found;
}

/** True when registering this alias would collide with a real top-level file or folder (flagged at registration). */
export function aliasCollidesWithPath(alias: string, pathExists: (name: string) => boolean): boolean {
  return pathExists(alias) || pathExists(`${alias}.json`) || pathExists(`${alias}.md`);
}
