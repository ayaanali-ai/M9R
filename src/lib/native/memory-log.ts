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
  createdAt: string;
}

export interface MemoryLog {
  add(text: string, scope?: MemoryScope): MemoryEntry | undefined;
  list(scope?: MemoryScope): readonly MemoryEntry[];
  remove(id: string): boolean;
}

const FILE_NAME = "memory-log.json";
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
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

export function createMemoryLog(root: string, now: () => Date = () => new Date()): MemoryLog {
  const path = join(root, FILE_NAME);
  let entries: MemoryEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const items = parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
    entries = items.filter(valid).slice(-MAX_ENTRIES);
  } catch { /* missing or malformed memory is intentionally treated as empty */ }

  let pending = Promise.resolve();
  const persist = () => {
    const temp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, entries }) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch { try { unlinkSync(temp); } catch { /* best effort */ } }
  };

  return {
    add(text, scope = "global") {
      const trimmed = text.trim().slice(0, MAX_TEXT_CHARS);
      if (!trimmed || !validScope(scope)) return undefined;
      const entry: MemoryEntry = { id: randomUUID(), text: trimmed, scope, createdAt: now().toISOString() };
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
      pending = pending.then(persist, persist);
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
      pending = pending.then(persist, persist);
      return true;
    },
  };
}
