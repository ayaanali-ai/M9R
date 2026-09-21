/**
 * `m9r-cli memory`: shows where this project's shared memory lives and what is in it, and (with --rebuild) writes the
 * short summaries and the index for sessions saved before summaries existed. Read-mostly; --rebuild only ever adds
 * `*.summary.md` files and `index.md` inside the memory folder, never touching the transcripts.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SUMMARY_SUFFIX, buildIndex, buildSummary, emptyFacts, parseSummary, type IndexEntry } from "@/lib/memory-distill-core";

export interface MemoryIo {
  cwd: string;
  out(line: string): void;
  err(line: string): void;
}

export const MEMORY_REL = join(".oathlock", "memory");

/** The nearest `.oathlock/memory` at or above `start`. */
export function findMemoryDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, MEMORY_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walk(dir: string, visit: (path: string) => void) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

const isTranscript = (name: string) => name.endsWith(".md") && !name.endsWith(SUMMARY_SUFFIX) && name !== "index.md";

/** Header fields of a saved transcript, whichever writer produced it (local capture or dashboard export). */
function transcriptFacts(markdown: string, file: string, root: string) {
  const field = (name: string) => markdown.match(new RegExp(`^- ${name}: (.+)$`, "m"))?.[1]?.trim();
  const segments = relative(root, file).split(sep);
  const messages: Array<{ sender: string; body: string }> = [];
  let sender: string | null = null;
  let body: string[] = [];
  const flush = () => { if (sender && body.join("\n").trim()) messages.push({ sender, body: body.join("\n").trim() }); sender = null; body = []; };
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(/^\*\*(.+):\*\*$/);
    if (h) { flush(); sender = h[1]; } else if (sender) body.push(line);
  }
  flush();
  return {
    provider: field("Provider") ?? (segments[0] === "local" ? segments[1] : "Shared channel"),
    sessionId: field("Session id") ?? (segments[segments.length - 1] ?? "").replace(/\.md$/, ""),
    whenIso: field("Captured") ?? field("Archived") ?? statSync(file).mtime.toISOString(),
    cwd: field("Working directory") ?? "",
    // Dashboard exports label senders by name; treat the first message as the request and the last as the answer.
    transcript: messages.map((m, i) => ({ sender: m.sender === "User" || m.sender === "Assistant" ? m.sender : i === 0 ? "User" : "Assistant", body: m.body })),
  };
}

/** Writes any missing summary beside its transcript, then rebuilds `index.md` from every summary on disk. */
export function rebuildMemory(root: string): { summarised: number; indexed: number } {
  let summarised = 0;
  const transcripts: string[] = [];
  walk(root, (path) => { if (isTranscript(path.slice(path.lastIndexOf(sep) + 1))) transcripts.push(path); });
  for (const file of transcripts) {
    const summaryPath = file.replace(/\.md$/, SUMMARY_SUFFIX);
    if (existsSync(summaryPath)) continue;
    try {
      const t = transcriptFacts(readFileSync(file, "utf8"), file, root);
      writeFileSync(summaryPath, buildSummary({ provider: t.provider, sessionId: t.sessionId, cwd: t.cwd, capturedAtIso: t.whenIso, transcript: t.transcript, facts: emptyFacts(), factsKnown: false }), "utf8");
      summarised += 1;
    } catch { /* one unreadable file must not stop the rest */ }
  }
  const entries: IndexEntry[] = [];
  walk(root, (path) => {
    if (!path.endsWith(SUMMARY_SUFFIX)) return;
    const entry = parseSummary(readFileSync(path, "utf8"), relative(root, path).split(sep).join("/"));
    if (entry) entries.push(entry);
  });
  writeFileSync(join(root, "index.md"), buildIndex(entries), "utf8");
  return { summarised, indexed: entries.length };
}

export function runMemory(rest: string[], io: MemoryIo): number {
  const root = findMemoryDir(io.cwd);
  if (!root) {
    io.out("No memory folder here yet.");
    io.out("It is created as agent sessions finish once capture is installed: run `m9r-cli capture install` in this project.");
    return 0;
  }
  if (rest.includes("--rebuild")) {
    const r = rebuildMemory(root);
    io.out(`Wrote ${r.summarised} new summar${r.summarised === 1 ? "y" : "ies"} and rebuilt the index (${r.indexed} session${r.indexed === 1 ? "" : "s"}).`);
  }
  let transcripts = 0;
  let summaries = 0;
  let bytes = 0;
  walk(root, (path) => {
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (isTranscript(name)) { transcripts += 1; bytes += statSync(path).size; }
    else if (name.endsWith(SUMMARY_SUFFIX)) summaries += 1;
  });
  io.out(`Memory folder: ${root}`);
  io.out(`${transcripts} saved session transcript(s), ${(bytes / 1_048_576).toFixed(1)} MB; ${summaries} short summar${summaries === 1 ? "y" : "ies"}.`);
  const indexPath = join(root, "index.md");
  if (!existsSync(indexPath)) {
    io.out("No index yet. Agents are pointed at index.md, so run `m9r-cli memory --rebuild` to create summaries and the index.");
    return 0;
  }
  io.out(`Index (what agents read first): ${indexPath}`);
  const lines = readFileSync(indexPath, "utf8").split(/\r?\n/).filter((l) => l.startsWith("- ")).slice(0, 8);
  if (lines.length) { io.out("Most recent:"); for (const l of lines) io.out(`  ${l.slice(2)}`); }
  if (summaries < transcripts) io.out(`${transcripts - summaries} older session(s) have no summary yet: run \`m9r-cli memory --rebuild\`.`);
  return 0;
}
