"use client";

import type { Highlighter } from "shiki";
import { olDiffTheme } from "./shiki-diff-theme";

/**
 * Lazy singleton Shiki highlighter for the Files panel's diff view. Only the
 * languages actually likely to show up in a coding-agent's file activity are
 * bundled -- not Shiki's full ~200-language set, which would bloat the
 * Watchfloor route for a feature most page loads never touch (this module
 * is only imported from files-panel.tsx, and only exercised once a diff is
 * actually selected -- see loadHighlighter's call site).
 */
const BUNDLED_LANGS = [
  "typescript", "tsx", "javascript", "jsx", "json", "css", "markdown",
  "python", "sql", "shellscript", "yaml", "html",
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

function loadHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: [olDiffTheme], langs: [...BUNDLED_LANGS] }),
    );
  }
  return highlighterPromise;
}

const EXTENSION_TO_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "json",
  css: "css",
  md: "markdown", mdx: "markdown",
  py: "python",
  sql: "sql",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  yml: "yaml", yaml: "yaml",
  html: "html", htm: "html",
};

export function langForPath(filePath: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  if (!match) return null;
  return EXTENSION_TO_LANG[match[1].toLowerCase()] ?? null;
}

/** Highlights one line of code to an inline-safe HTML string (a bare `<span>`
 * run, no wrapping `<pre>`/`<code>`) -- the caller supplies its own line
 * structure (see files-panel.tsx's DiffLines) since diff coloring is applied
 * per-line as a background, not per-token. Falls back to plain escaped text
 * for an unrecognized language or a load failure -- a diff must always be
 * readable even when highlighting isn't available. */
export async function highlightLine(code: string, lang: string | null): Promise<string> {
  if (!lang) return escapeHtml(code);
  try {
    const highlighter = await loadHighlighter();
    if (!highlighter.getLoadedLanguages().includes(lang)) return escapeHtml(code);
    const html = highlighter.codeToHtml(code, { lang, theme: "ol-diff" });
    // Shiki wraps in <pre class="shiki"><code>...</code></pre> -- unwrap to
    // just the inner spans since the caller owns the line/pre structure.
    const match = /<code>([\s\S]*)<\/code>/.exec(html);
    return match ? match[1] : escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
