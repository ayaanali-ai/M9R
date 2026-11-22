import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { renameStateFile } from "./atomic-file";

/**
 * A durable, owner-profile browser "space".  This is intentionally a ledger,
 * not a second browser engine: the native stage still owns the real HWND and
 * all input/observation.  The ledger only remembers which exact browser window
 * belongs to a logical work surface so a broker restart can rebind explicitly
 * instead of guessing by title, size, or enumeration order.
 */
export interface BrowserSpaceRecord {
  readonly spaceId: string;
  readonly stageName: string;
  readonly browser: "chrome" | "msedge";
  readonly pid: number;
  readonly windowId: string;
  readonly processGeneration?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrowserSpaceLedger {
  bind(input: Omit<BrowserSpaceRecord, "createdAt" | "updatedAt"> & { now?: Date }): BrowserSpaceRecord;
  get(spaceId: string): BrowserSpaceRecord | undefined;
  remove(spaceId: string): void;
  list(): readonly BrowserSpaceRecord[];
}

const FILE_NAME = "browser-spaces.json";
const MAX_SPACES = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:%-]{0,127}$/;
const WINDOW = /^(?:0[xX][0-9a-f]+|[1-9][0-9]*)$/i;
const GENERATION = /^[a-f0-9]{16}$/i;

function validRecord(value: unknown): value is BrowserSpaceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.spaceId === "string" && ID.test(item.spaceId)
    && typeof item.stageName === "string" && ID.test(item.stageName)
    && (item.browser === "chrome" || item.browser === "msedge")
    && Number.isSafeInteger(item.pid) && (item.pid as number) > 0
    && typeof item.windowId === "string" && WINDOW.test(item.windowId)
    && (item.processGeneration === undefined || (typeof item.processGeneration === "string" && GENERATION.test(item.processGeneration)))
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt));
}

function normalized(value: string, label: string): string {
  const result = value.trim();
  if (!ID.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function persist(path: string, records: Map<string, BrowserSpaceRecord>): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, spaces: [...records.values()].sort((a, b) => a.spaceId.localeCompare(b.spaceId)) }) + "\n", { encoding: "utf8", mode: 0o600 });
    renameStateFile(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

export function createBrowserSpaceLedger(root: string): BrowserSpaceLedger {
  const path = join(root, FILE_NAME);
  const records = new Map<string, BrowserSpaceRecord>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { spaces?: unknown }).spaces
      : undefined;
    if (Array.isArray(values)) for (const value of values.slice(-MAX_SPACES)) if (validRecord(value)) records.set(value.spaceId, value);
  } catch { /* first run or corrupt optional ledger: start empty, never guess */ }

  return {
    bind(input) {
      const spaceId = normalized(input.spaceId, "Browser space id");
      const stageName = normalized(input.stageName, "Browser stage name");
      if (!Number.isSafeInteger(input.pid) || input.pid < 1) throw new Error("Browser space PID is invalid.");
      if (!WINDOW.test(input.windowId)) throw new Error("Browser space window identity is invalid.");
      if (input.processGeneration !== undefined && !GENERATION.test(input.processGeneration)) throw new Error("Browser space process generation is invalid.");
      const now = input.now ?? new Date();
      const previous = records.get(spaceId);
      const record: BrowserSpaceRecord = {
        spaceId, stageName, browser: input.browser, pid: input.pid, windowId: input.windowId,
        ...(input.processGeneration ? { processGeneration: input.processGeneration } : {}),
        createdAt: previous?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
      };
      if (!previous && records.size >= MAX_SPACES) throw new Error("The browser space ledger is full; close an old space before creating another.");
      records.set(spaceId, record);
      persist(path, records);
      return record;
    },
    get(spaceId) { return records.get(spaceId); },
    remove(spaceId) { if (records.delete(spaceId)) persist(path, records); },
    list() { return [...records.values()].sort((a, b) => a.spaceId.localeCompare(b.spaceId)); },
  };
}
