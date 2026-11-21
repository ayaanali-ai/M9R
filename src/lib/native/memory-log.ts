import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * The user-visible memory log: short, human-sentence notes about the user (not raw
 * prompts, not screenshots, not secrets), local-only, always readable and individually
 * deletable. Deliberately simpler than a vector/graph memory engine -- one user, one
 * machine, a bounded list is the whole problem. See project_demo_launch_checklist
 * (phase 2) for why: visibility/editability is the differentiator, not retrieval depth.
 */
export type MemoryScope = "global" | `persona:${string}`;

export interface MemoryEntry {
  id: string;
  text: string;
  scope: MemoryScope;
  /** Which agent/persona wrote this (e.g. "codex", "claude-code"); undefined for user/system-authored entries. */
  author?: string;
  createdAt: string;
}

export interface MemoryLog {
  add(text: string, scope?: MemoryScope, author?: string): MemoryEntry | undefined;
  list(scope?: MemoryScope): readonly MemoryEntry[];
  remove(id: string): boolean;
}

// JSONL, not one big JSON array: every agent is a separate OS process sharing this one
// file (the "teammates, no walls" model), and an append is effectively race-safe across
// processes where a read-modify-rewrite of a whole array is not -- two agents writing at
// nearly the same moment would otherwise silently clobber each other's entry. remove()
// still has to rewrite (you can't un-append a line), but removes are rare/user-driven,
// unlike add() which happens constantly as agents work.
const FILE_NAME = "memory-log.jsonl";
const MAX_ENTRIES = 300;
const MAX_TEXT_CHARS = 240;

function validScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (value === "global" || value.startsWith("persona:"));
}

function valid(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.text === "string" && item.text.length > 0 && item.text.length <= MAX_TEXT_CHARS
    && validScope(item.scope)
    && (item.author === undefined || (typeof item.author === "string" && item.author.length > 0))
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

function readAll(path: string): MemoryEntry[] {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const out: MemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (valid(parsed)) out.push(parsed);
    } catch { /* a torn/partial line from a concurrent writer is skipped, not fatal */ }
  }
  return out;
}

function rewrite(path: string, entries: MemoryEntry[]): void {
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch { try { unlinkSync(temp); } catch { /* best effort */ } }
}

export function createMemoryLog(root: string, now: () => Date = () => new Date()): MemoryLog {
  const path = join(root, FILE_NAME);
  // Compacted (bounded, de-duped against malformed lines) once at load, so the file's
  // size cap is enforced even though add() below no longer rewrites the whole file.
  const loaded = readAll(path);
  let entries: MemoryEntry[] = loaded.slice(-MAX_ENTRIES);
  if (entries.length !== loaded.length) rewrite(path, entries);

  let pending = Promise.resolve();

  return {
    add(text, scope = "global", author) {
      const trimmed = text.trim().slice(0, MAX_TEXT_CHARS);
      if (!trimmed || !validScope(scope)) return undefined;
      const entry: MemoryEntry = { id: randomUUID(), text: trimmed, scope, ...(author ? { author } : {}), createdAt: now().toISOString() };
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
      pending = pending.then(() => {
        try { writeFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600, flag: "a" }); } catch { /* best effort */ }
      });
      return entry;
    },
    list(scope) {
      // Newest first. Entries are always appended in insertion order, so reversing
      // avoids a createdAt sort misordering same-millisecond writes (sort is stable,
      // but ties then keep ascending insertion order, which is the wrong direction).
      const filtered = scope ? entries.filter((e) => e.scope === scope) : entries;
      return [...filtered].reverse();
    },
    remove(id) {
      const before = entries.length;
      entries = entries.filter((e) => e.id !== id);
      if (entries.length === before) return false;
      pending = pending.then(() => rewrite(path, entries));
      return true;
    },
  };
}
