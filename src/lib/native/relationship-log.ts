import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * How two agents' collaboration has actually gone, derived on read rather than stored as
 * a running score (one source of truth, no drift). Deliberately narrow vocabulary -- the
 * four kinds below are the minimum that predicts "should I trust this agent's output
 * here," not a general activity log. See project memory on the memory layer for why this
 * is a separate file from memory-log.ts: denser and more specific, so it is surfaced only
 * where relevant (a handoff) rather than injected into every session.
 */
export type RelationshipKind = "handoff" | "correction" | "praise" | "friction";

export interface RelationshipEntry {
  id: string;
  pair: string;
  kind: RelationshipKind;
  note: string;
  createdAt: string;
}

export interface RelationshipSummary {
  pair: string;
  counts: Record<RelationshipKind, number>;
  recentNotes: readonly Pick<RelationshipEntry, "kind" | "note" | "createdAt">[];
}

export interface RelationshipLog {
  relate(agentA: string, agentB: string, kind: RelationshipKind, note: string): RelationshipEntry | undefined;
  summary(agentA: string, agentB: string): RelationshipSummary;
}

const FILE_NAME = "relationship-log.jsonl";
const MAX_ENTRIES = 500;
const MAX_NOTE_CHARS = 160;
const RECENT_NOTES = 3;
const KINDS: readonly RelationshipKind[] = ["handoff", "correction", "praise", "friction"];

function pairKey(agentA: string, agentB: string): string | undefined {
  const a = agentA.trim();
  const b = agentB.trim();
  if (!a || !b || a === b) return undefined;
  return [a, b].sort().join("|");
}

function validKind(value: unknown): value is RelationshipKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function valid(value: unknown): value is RelationshipEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.pair === "string" && item.pair.includes("|")
    && validKind(item.kind)
    && typeof item.note === "string" && item.note.length > 0 && item.note.length <= MAX_NOTE_CHARS
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

function readAll(path: string): RelationshipEntry[] {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const out: RelationshipEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (valid(parsed)) out.push(parsed);
    } catch { /* a torn/partial line from a concurrent writer is skipped, not fatal */ }
  }
  return out;
}

export function createRelationshipLog(root: string, now: () => Date = () => new Date()): RelationshipLog {
  const path = join(root, FILE_NAME);
  let entries: RelationshipEntry[] = readAll(path).slice(-MAX_ENTRIES);
  let pending = Promise.resolve();

  return {
    relate(agentA, agentB, kind, note) {
      const pair = pairKey(agentA, agentB);
      const trimmed = note.trim().slice(0, MAX_NOTE_CHARS);
      if (!pair || !trimmed || !validKind(kind)) return undefined;
      const entry: RelationshipEntry = { id: randomUUID(), pair, kind, note: trimmed, createdAt: now().toISOString() };
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
      pending = pending.then(() => {
        try { writeFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600, flag: "a" }); } catch { /* best effort */ }
      });
      return entry;
    },
    summary(agentA, agentB) {
      const pair = pairKey(agentA, agentB) ?? [agentA, agentB].sort().join("|");
      const forPair = entries.filter((e) => e.pair === pair);
      const counts: Record<RelationshipKind, number> = { handoff: 0, correction: 0, praise: 0, friction: 0 };
      for (const e of forPair) counts[e.kind]++;
      const recentNotes = [...forPair].reverse().slice(0, RECENT_NOTES)
        .map(({ kind, note, createdAt }) => ({ kind, note, createdAt }));
      return { pair, counts, recentNotes };
    },
  };
}
