/** Append-only local event log for page notes. Clear/archive operations add events; they never rewrite note entries. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPageNotesCore, type PageNoteEvent, type PageNotesCoreOptions } from "./page-notes-core";

const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 15_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export type PageNotesStoreOptions = Omit<PageNotesCoreOptions, "events">;

function isEvent(value: unknown): value is PageNoteEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (event.type === "note.appended") {
    const note = event.note as Record<string, unknown> | null;
    return Boolean(note && typeof note === "object" && typeof note.id === "string" && typeof note.room === "string" && typeof note.agent === "string" && typeof note.text === "string" && (note.source === "agent" || note.source === "page") && note.untrusted === (note.source === "page") && typeof note.sourceUrl === "string" && typeof note.origin === "string" && typeof note.path === "string" && typeof note.createdAt === "number");
  }
  if (event.type === "note.archived") return typeof event.noteId === "string" && typeof event.at === "number" && ["retention", "page_cap", "room_cap"].includes(String(event.reason));
  if (event.type === "notes.cleared") return typeof event.room === "string" && typeof event.at === "number" && (event.origin === undefined || typeof event.origin === "string") && (event.path === undefined || typeof event.path === "string");
  return false;
}

export function createPageNotesStore(root: string, options: PageNotesStoreOptions = {}) {
  const eventPath = join(root, "page-notes.jsonl");
  const lockPath = join(root, "page-notes.lock");

  function acquire(): void {
    mkdirSync(root, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch { /* lock vanished; retry */ }
        if (Date.now() > deadline) throw new Error("The M9R page-notes store is busy; try again.");
        sleepSync(15);
      }
    }
  }

  function release(): void {
    rmSync(lockPath, { recursive: true, force: true });
  }

  function readEvents(): PageNoteEvent[] {
    if (!existsSync(eventPath)) return [];
    const raw = readFileSync(eventPath, "utf8");
    const events: PageNoteEvent[] = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new Error(`The M9R page-notes log is corrupt at line ${index + 1}; refusing to overwrite it.`); }
      if (!isEvent(parsed)) throw new Error(`The M9R page-notes log has an invalid event at line ${index + 1}; refusing to overwrite it.`);
      events.push(parsed);
    }
    return events;
  }

  function run<T>(operation: (core: ReturnType<typeof createPageNotesCore>) => T): T {
    acquire();
    try {
      const core = createPageNotesCore({ ...options, events: readEvents() });
      const priorCount = core.events().length;
      const result = operation(core);
      const added = core.events().slice(priorCount);
      if (added.length) appendFileSync(eventPath, `${added.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      return result;
    } finally {
      release();
    }
  }

  return {
    append: (input: Parameters<ReturnType<typeof createPageNotesCore>["append"]>[0]) => run((core) => core.append(input)),
    list: (room: string, sourceUrl?: string) => run((core) => core.list(room, sourceUrl)),
    clear: (room: string, sourceUrl?: string) => run((core) => core.clear(room, sourceUrl)),
    exportMarkdown: (room: string, sourceUrl?: string) => run((core) => core.exportMarkdown(room, sourceUrl)),
    events: () => {
      acquire();
      try { return readEvents(); } finally { release(); }
    },
    filePath: eventPath,
  };
}

export type PageNotesStore = ReturnType<typeof createPageNotesStore>;
