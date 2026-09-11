/**
 * A real, verified gap: the prompt-level instruction telling agents to use
 * real line breaks for list-style answers (see MANDATORY_REPORT_INSTRUCTION
 * in bridge-runtime.ts) does not reliably work -- confirmed live, twice,
 * with fresh test messages that both came back as one run-on paragraph
 * despite the instruction being loaded in the running build. Prompt
 * compliance is probabilistic; this is deterministic instead: applied to
 * every agent-authored message body at the one real choke point all three
 * providers' send_message calls funnel through (see
 * src/app/api/agent/conversations/[id]/messages/route.ts), so it can't be
 * skipped by a model that ignores instructions.
 *
 * Targets exactly the two failure patterns actually observed live, nothing
 * broader -- a generic "insert newlines anywhere" transform would mangle
 * normal prose. Deliberately conservative: a pattern must repeat at least
 * twice in one message before anything is touched, so a single "1. " or
 * one em-dash in an ordinary sentence is left completely alone.
 */

/** "1. a 2. b 3. c" -- a numbered list inlined into one run-on sentence.
 * Real example seen live: "Five largest files in src/lib: 1. oathlock-cli-
 * core.ts — 2586 lines 2. conversation-service.ts — 1847 lines 3. ..." */
const NUMBERED_MARKER = /(?:^|\s)(\d{1,3}\.)\s+(?=\S)/g;

/** "identifierName — description. anotherIdentifier — description." -- an
 * export/field list inlined the same way. Real example seen live:
 * "recordWorkspaceFileActivity — inserts... listCurrentWorkspaceFileActivity
 * — returns..." Matches a camelCase/PascalCase-looking identifier (has an
 * internal capital, so it can't just be an ordinary capitalized sentence
 * word) immediately followed by an em-dash. */
const IDENTIFIER_EM_DASH = /(?:^|(?<=[.:]\s))([A-Za-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\s+—\s/g;

function countMatches(text: string, pattern: RegExp): number {
  const withGlobal = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return (text.match(withGlobal) ?? []).length;
}

export function reformatRunOnListReply(text: string): string {
  if (!text) return text;

  const numberedCount = countMatches(text, NUMBERED_MARKER);
  if (numberedCount >= 2) {
    return text.replace(NUMBERED_MARKER, (match, marker: string, offset: number) =>
      offset === 0 ? `${marker} ` : `\n${marker} `,
    ).trim();
  }

  const identifierCount = countMatches(text, IDENTIFIER_EM_DASH);
  if (identifierCount >= 2) {
    let seen = 0;
    return text.replace(IDENTIFIER_EM_DASH, (match, identifier: string) => {
      seen += 1;
      return seen === 1 ? `${identifier} — ` : `\n${identifier} — `;
    }).trim();
  }

  return text;
}
