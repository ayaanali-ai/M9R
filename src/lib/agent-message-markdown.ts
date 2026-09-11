/**
 * Small, deliberately bounded markdown parser for agent responses.
 *
 * This is not a general CommonMark implementation. Agent replies use a small
 * predictable subset, and keeping the parser local means the chat surface
 * does not gain a new runtime dependency or an HTML injection path.
 */

export type AgentMessageBlock =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; lang: string | null; text: string };

export type AgentMessageInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string };

const FENCE_PATTERN = /^\s*```\s*([A-Za-z0-9_-]+)?\s*$/;
const HEADING_PATTERN = /^\s*(#{2,3})\s+(.+?)\s*#*\s*$/;
const UNORDERED_ITEM_PATTERN = /^\s*[-*+]\s+(.+)$/;
const ORDERED_ITEM_PATTERN = /^\s*\d+[.)]\s+(.+)$/;
const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

/** Tokenize only the inline constructs the chat renderer intentionally supports. */
export function parseAgentMessageInline(text: string): AgentMessageInline[] {
  const tokens: AgentMessageInline[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ type: "text", text: text.slice(cursor, index) });
    if (value.startsWith("`")) tokens.push({ type: "code", text: value.slice(1, -1) });
    else tokens.push({ type: "strong", text: value.slice(2, -2) });
    cursor = index + value.length;
  }

  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
  return tokens.length > 0 ? tokens : [{ type: "text", text }];
}

/**
 * Parse headings, paragraphs, simple lists, and fenced code blocks without
 * interpreting raw HTML or links as markup.
 */
export function parseAgentMessage(body: string): AgentMessageBlock[] {
  const blocks: AgentMessageBlock[] = [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let listOrdered: boolean | null = null;
  let codeLines: string[] | null = null;
  let codeLang: string | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
    paragraphLines = [];
  };
  const flushList = () => {
    if (listItems.length === 0 || listOrdered === null) return;
    blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    listItems = [];
    listOrdered = null;
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (codeLines !== null) {
      if (FENCE_PATTERN.test(line)) {
        blocks.push({ type: "code", lang: codeLang, text: codeLines.join("\n") });
        codeLines = null;
        codeLang = null;
      } else codeLines.push(line);
      continue;
    }

    const fence = line.match(FENCE_PATTERN);
    if (fence) {
      flushText();
      codeLines = [];
      codeLang = fence[1] ?? null;
      continue;
    }

    if (line.trim() === "") {
      flushText();
      continue;
    }

    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      flushText();
      blocks.push({ type: "heading", level: heading[1].length as 2 | 3, text: heading[2] });
      continue;
    }

    const unordered = line.match(UNORDERED_ITEM_PATTERN);
    const ordered = line.match(ORDERED_ITEM_PATTERN);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      if (listOrdered !== null && listOrdered !== isOrdered) flushList();
      flushParagraph();
      listOrdered = isOrdered;
      listItems.push((unordered ?? ordered)![1].trim());
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  if (codeLines !== null) blocks.push({ type: "code", lang: codeLang, text: codeLines.join("\n") });
  flushText();
  return blocks;
}
