import { redactSession } from "@/lib/session-redaction";

/**
 * C1 (M9R_NEXT_BUILD_PLAN.md section 8): a short, deterministic summary written beside each raw captured transcript, plus
 * one index line per session. Agents read these instead of transcripts that can run to 500 KB. No model calls.
 *
 * Scope cut kept from the capture parsers: only file PATHS and one-line command text are taken from tool arguments,
 * never file contents, diffs or tool results, and everything shown passes through the same redaction as the transcript.
 */

export interface SessionFacts {
  files: string[];
  commands: string[];
}

export interface DistillInput {
  provider: string;
  sessionId: string;
  cwd: string;
  capturedAtIso: string;
  transcript: Array<{ sender: string; body: string }>;
  facts: SessionFacts;
  /** False for sessions summarised after the fact from a transcript that no longer carries tool arguments. */
  factsKnown?: boolean;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write", "patch"]);
const MAX_FILES = 15;
const MAX_COMMANDS = 8;
const GOAL_CHARS = 300;
const FINAL_CHARS = 600;
const COMMAND_CHARS = 120;

export function emptyFacts(): SessionFacts {
  return { files: [], commands: [] };
}

function pushUnique(list: string[], value: string, cap: number) {
  if (value && !list.includes(value) && list.length < cap) list.push(value);
}

function addToolUse(facts: SessionFacts, name: string, input: unknown) {
  if (!input || typeof input !== "object") return;
  const i = input as Record<string, unknown>;
  if (FILE_TOOLS.has(name)) {
    const path = [i.file_path, i.notebook_path, i.filePath, i.path].find((v): v is string => typeof v === "string" && v.trim() !== "");
    if (path) pushUnique(facts.files, path.trim(), MAX_FILES * 4);
  } else if (name === "Bash" || name === "bash") {
    const command = typeof i.command === "string" ? i.command : "";
    if (command.trim()) pushUnique(facts.commands, command.trim(), MAX_COMMANDS * 4);
  }
}

/** Claude Code JSONL: tool_use blocks carry `name` and `input`. */
export function extractClaudeFacts(jsonlText: string): SessionFacts {
  const facts = emptyFacts();
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.includes("tool_use")) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const content = (record as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: unknown } | null;
      if (b?.type === "tool_use" && typeof b.name === "string") addToolUse(facts, b.name, b.input);
    }
  }
  return facts;
}

/** Codex rollout JSONL: apply_patch text names files; shell calls carry a command. Best effort, unknown shapes are skipped. */
export function extractCodexFacts(jsonlText: string): SessionFacts {
  const facts = emptyFacts();
  const patchFile = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.includes("apply_patch") && !line.includes("shell") && !line.includes("exec_command")) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = ((record as { payload?: unknown } | null)?.payload ?? record) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") continue;
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    if (!args) continue;
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(args) as Record<string, unknown>; } catch { parsed = null; }
    const command = parsed?.command ?? parsed?.cmd;
    const text = Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";
    if (text) {
      for (const m of text.matchAll(patchFile)) pushUnique(facts.files, m[1].trim(), MAX_FILES * 4);
      if (!text.includes("apply_patch")) pushUnique(facts.commands, text.trim(), MAX_COMMANDS * 4);
    }
  }
  return facts;
}

/** OpenCode export: `tool` parts hold `state.input` (edit/write/bash). */
export function extractOpenCodeFacts(raw: unknown): SessionFacts {
  const facts = emptyFacts();
  const messages = (raw as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return facts;
  for (const entry of messages) {
    const parts = (entry as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { type?: string; tool?: string; state?: { input?: unknown } } | null;
      if (p?.type === "tool" && typeof p.tool === "string") addToolUse(facts, p.tool, p.state?.input);
    }
  }
  return facts;
}

const clean = (text: string) => redactSession(text, { includeHeuristics: true }).redactedText;
const oneLine = (text: string, max: number) => {
  const flat = clean(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Paths relative to the session's working directory when they sit inside it, forward slashes, so the index is portable. */
export function relativePath(path: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(path);
  const c = norm(cwd).replace(/\/+$/, "");
  return c && p.toLowerCase().startsWith(`${c.toLowerCase()}/`) ? p.slice(c.length + 1) : p;
}

const CONTINUATION = /^This session is being continued/i;

function firstGoal(transcript: DistillInput["transcript"]): string {
  const users = transcript.filter((m) => m.sender === "User" && m.body.replace(/\[tool result omitted\]/g, "").trim());
  const own = users.find((m) => !CONTINUATION.test(m.body.trim()));
  if (own) return oneLine(own.body.replace(/\[tool result omitted\]/g, ""), GOAL_CHARS);
  // A continued session opens with an automatic recap; its own request is under "Primary Request and Intent".
  const recap = users[0]?.body.match(/Primary Request and Intent:?\s*([\s\S]{20,})/i)?.[1];
  return recap ? `(continued) ${oneLine(recap, GOAL_CHARS - 12)}` : "(no prompt captured)";
}

function finalMessage(transcript: DistillInput["transcript"]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const m = transcript[i];
    if (m.sender !== "Assistant") continue;
    const text = m.body.replace(/\[used tool: [^\]]*\]/g, "").replace(/\[tool result omitted\]/g, "").trim();
    if (text) return oneLine(text, FINAL_CHARS);
  }
  return "(no final message captured)";
}

export const SUMMARY_SUFFIX = ".summary.md";

export function buildSummary(input: DistillInput): string {
  const files = input.facts.files.map((f) => relativePath(f, input.cwd));
  const shown = files.slice(0, MAX_FILES);
  const commands = input.facts.commands.map((c) => oneLine(c.split(/\r?\n/)[0], COMMAND_CHARS)).slice(0, MAX_COMMANDS);
  const lines = [
    `# Session summary: ${oneLine(firstGoal(input.transcript), 80)}`,
    "",
    `- Provider: ${input.provider}`,
    `- When: ${input.capturedAtIso}`,
    `- Working directory: ${input.cwd}`,
    `- Session id: ${input.sessionId}`,
    `- Full transcript (large, read only if this is not enough): ${input.sessionId}.md`,
    "",
    "## Goal",
    firstGoal(input.transcript),
    "",
    "## Files changed",
    ...(shown.length ? shown.map((f) => `- ${f}`) : [input.factsKnown === false ? "- (not recorded for this older session)" : "- (none recorded)"]),
    ...(files.length > shown.length ? [`- ...and ${files.length - shown.length} more`] : []),
    "",
    "## Commands run",
    ...(commands.length ? commands.map((c) => `- \`${c.replace(/`/g, "'")}\``) : [input.factsKnown === false ? "- (not recorded for this older session)" : "- (none recorded)"]),
    "",
    "## Final message",
    finalMessage(input.transcript),
    "",
  ];
  return lines.join("\n");
}

export interface IndexEntry {
  provider: string;
  sessionId: string;
  whenIso: string;
  goal: string;
  files: string[];
  /** Path of the summary file relative to the memory folder, forward slashes. */
  summaryPath: string;
}

/** Reads one summary file back into an index entry, so the index can be rebuilt from disk without keeping state. */
export function parseSummary(markdown: string, summaryPath: string): IndexEntry | null {
  const field = (name: string) => markdown.match(new RegExp(`^- ${name}: (.+)$`, "m"))?.[1]?.trim();
  const sessionId = field("Session id");
  const whenIso = field("When");
  if (!sessionId || !whenIso) return null;
  const goal = markdown.match(/^## Goal\r?\n([^\r\n]*)/m)?.[1]?.trim() ?? "";
  const filesBlock = markdown.split(/^## /m).find((sec) => sec.startsWith("Files changed")) ?? "";
  const files = [...filesBlock.matchAll(/^- (?!\(none|\(not recorded|\.\.\.and)(.+)$/gm)].map((m) => m[1].trim());
  return { provider: field("Provider") ?? "unknown", sessionId, whenIso, goal, files, summaryPath };
}

const INDEX_MAX_ENTRIES = 60;
const INDEX_FILES_PER_LINE = 4;

/** One line per recent session, newest first, small enough to read whole (about 40 tokens a line). */
export function buildIndex(entries: IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => b.whenIso.localeCompare(a.whenIso)).slice(0, INDEX_MAX_ENTRIES);
  const lines = [
    "# Memory index",
    "",
    "Earlier sessions on this machine, newest first. Each line links to a short summary. Read a summary before re-deriving work.",
    "Only open the full transcript (same name without `.summary`) if the summary is not enough.",
    "",
  ];
  if (!sorted.length) lines.push("_(no sessions yet)_");
  for (const e of sorted) {
    const files = e.files.slice(0, INDEX_FILES_PER_LINE).join(", ");
    const more = e.files.length > INDEX_FILES_PER_LINE ? ` +${e.files.length - INDEX_FILES_PER_LINE}` : "";
    lines.push(`- ${e.whenIso.slice(0, 10)} ${e.provider}: ${oneLine(e.goal, 90)}${files ? ` [${files}${more}]` : ""} -> ${e.summaryPath}`);
  }
  lines.push("");
  return lines.join("\n");
}
