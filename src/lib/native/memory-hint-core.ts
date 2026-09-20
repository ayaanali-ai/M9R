/**
 * C1 item 4: a relevant-memory hint for the UserPromptSubmit hook. Matches the prompt against the local memory index
 * (`.oathlock/memory/index.md`, one line per session) and returns at most two one-line pointers, only on a real match.
 * No match means no output, so an ordinary prompt costs no tokens. Pure: the hook reads the file and passes the text in.
 */
export const MEMORY_DIR = ".oathlock/memory";
export const MAX_HINTS = 2;
const MAX_HINT_CHARS = 260;
const MIN_SCORE = 3;

const STOP = new Set(["that", "this", "with", "from", "have", "what", "when", "where", "which", "should", "could", "would", "there", "their", "about", "into", "just", "make", "need", "want", "please", "also", "then", "them", "they", "will", "your", "does", "done", "some", "more", "like", "here", "each", "over", "than", "only", "very", "file", "files", "code", "test", "tests", "session", "sessions", "agent", "agents", "work", "fix", "add", "the", "and", "for"]);

const words = (text: string) => [...new Set((text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter((w) => !STOP.has(w)))];
const pathTokens = (text: string) => [...new Set((text.match(/[\w.-]+(?:[\\/][\w.-]+)+|[\w-]+\.[a-z]{1,5}\b/gi) ?? []).map((p) => p.replace(/\\/g, "/").toLowerCase()))];

export interface MemoryHint {
  line: string;
  score: number;
}

/** A path in the prompt that names a file in a line's `[files]` scores 3 (enough alone); each shared word scores 1. */
export function findMemoryHints(prompt: string, indexText: string): string[] {
  if (!prompt.trim() || !indexText.trim()) return [];
  const promptWords = words(prompt);
  const promptPaths = pathTokens(prompt);
  const scored: MemoryHint[] = [];
  for (const raw of indexText.split(/\r?\n/)) {
    const m = raw.match(/^- (\S+) ([^:]+): (.*?)(?: \[(.*)\])? -> (\S+\.summary\.md)$/);
    if (!m) continue;
    const [, date, provider, goal, files = "", summary] = m;
    const lineFiles = files.replace(/ \+\d+$/, "").split(", ").map((f) => f.toLowerCase());
    let score = 0;
    for (const p of promptPaths) {
      if (lineFiles.some((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`))) score += 3;
    }
    const lineWords = new Set(words(`${goal} ${files}`));
    for (const w of promptWords) if (lineWords.has(w)) score += 1;
    if (score >= MIN_SCORE) {
      const text = `${date} ${provider}: ${goal}`.slice(0, MAX_HINT_CHARS - 60);
      scored.push({ score, line: `${text} (summary: ${MEMORY_DIR}/${summary})` });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_HINTS).map((h) => h.line);
}

export function renderMemoryHint(lines: string[]): string {
  if (!lines.length) return "";
  return `M9R memory: earlier session(s) may be relevant, read the short summary before re-deriving the work:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
