import { randomUUID } from "node:crypto";

export type PageNoteSource = "agent" | "page";
export type PageNoteArchiveReason = "retention" | "page_cap" | "room_cap";

export interface PageNote {
  id: string;
  room: string;
  agent: string;
  text: string;
  source: PageNoteSource;
  untrusted: boolean;
  sourceUrl: string;
  origin: string;
  path: string;
  selector?: string;
  createdAt: number;
}

export type PageNoteEvent =
  | { type: "note.appended"; note: PageNote }
  | { type: "note.archived"; noteId: string; at: number; reason: PageNoteArchiveReason }
  | { type: "notes.cleared"; room: string; origin?: string; path?: string; at: number };

export type PageNotesResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PageNotesCoreOptions {
  events?: readonly PageNoteEvent[];
  now?: () => number;
  newId?: () => string;
  maxPerPage?: number;
  maxPerRoom?: number;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NOTE_CHARS = 2_000;
const MAX_SELECTOR_CHARS = 500;

const SENSITIVE_TEXT = [
  /\b(?:sk|pk|rk)-[a-z0-9_-]{16,}\b/i,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/i,
  /\bxox[baprs]-[a-z0-9-]{16,}\b/i,
  /\bBearer\s+[a-z0-9._~+/-]{12,}/i,
  /\b(?:password|passwd|passcode|one[- ]time[- ]code|\botp)\s*[:=]\s*\S+/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

export function normalizePageUrl(value: string): PageNotesResult<{ sourceUrl: string; origin: string; path: string }> {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return { ok: false, error: "sourceUrl must be an HTTP(S) URL without embedded credentials" };
    }
    url.search = "";
    url.hash = "";
    return { ok: true, value: { sourceUrl: `${url.origin}${url.pathname}`, origin: url.origin, path: url.pathname || "/" } };
  } catch {
    return { ok: false, error: "sourceUrl must be a valid HTTP(S) URL" };
  }
}

function cleanLabel(value: string, max: number): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function cloneEvents(events: readonly PageNoteEvent[]): PageNoteEvent[] {
  return events.map((event) => event.type === "note.appended" ? { ...event, note: { ...event.note } } : { ...event });
}

export function createPageNotesCore(options: PageNotesCoreOptions = {}) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => randomUUID());
  const maxPerPage = Math.max(1, Math.floor(options.maxPerPage ?? 30));
  const maxPerRoom = Math.max(1, Math.floor(options.maxPerRoom ?? 200));
  const log: PageNoteEvent[] = cloneEvents(options.events ?? []);

  function activeNotes(): PageNote[] {
    const archived = new Set(log.filter((event): event is Extract<PageNoteEvent, { type: "note.archived" }> => event.type === "note.archived").map((event) => event.noteId));
    const clears = log.filter((event): event is Extract<PageNoteEvent, { type: "notes.cleared" }> => event.type === "notes.cleared");
    return log.flatMap((event) => {
      if (event.type !== "note.appended" || archived.has(event.note.id)) return [];
      const cleared = clears.some((clear) => clear.room === event.note.room && clear.at >= event.note.createdAt && (!clear.origin || (clear.origin === event.note.origin && clear.path === event.note.path)));
      return cleared ? [] : [event.note];
    });
  }

  function archive(note: PageNote, reason: PageNoteArchiveReason): void {
    log.push({ type: "note.archived", noteId: note.id, at: now(), reason });
  }

  function archiveExpired(): void {
    const cutoff = now() - RETENTION_MS;
    for (const note of activeNotes()) if (note.createdAt <= cutoff) archive(note, "retention");
  }

  function validateRoom(roomValue: string): string | undefined {
    if (roomValue.trim().length > 120) return undefined;
    const room = cleanLabel(roomValue, 120);
    if (!room || room.length > 120) return undefined;
    return room;
  }

  function filtered(room: string, page?: { origin: string; path: string }): PageNote[] {
    return activeNotes()
      .filter((note) => note.room === room && (!page || (note.origin === page.origin && note.path === page.path)))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  function append(input: { room: string; agent: string; text: string; source: PageNoteSource; sourceUrl: string; selector?: string }): PageNotesResult<{ note: PageNote; deduplicated: boolean }> {
    archiveExpired();
    const room = validateRoom(input.room);
    const agent = cleanLabel(input.agent, 80);
    const text = cleanLabel(input.text, MAX_NOTE_CHARS);
    const selector = input.selector === undefined ? undefined : cleanLabel(input.selector, MAX_SELECTOR_CHARS);
    if (!room || !agent || !text) return { ok: false, error: "room, authenticated agent, and note text are required" };
    if (input.text.length > MAX_NOTE_CHARS || input.selector?.length && input.selector.length > MAX_SELECTOR_CHARS) {
      return { ok: false, error: "note text or selector exceeds its size limit" };
    }
    if (input.source !== "agent" && input.source !== "page") return { ok: false, error: "source must be agent or page" };
    if (SENSITIVE_TEXT.some((pattern) => pattern.test(text) || (selector ? pattern.test(selector) : false))) {
      return { ok: false, error: "sensitive content is not stored; record a non-secret observation instead" };
    }
    if (selector && /\bvalue\s*=|\b(?:password|one[- ]time[- ]code|cc-number)\b/i.test(selector)) {
      return { ok: false, error: "selectors that contain form values or sensitive field markers are not stored" };
    }
    const normalizedUrl = normalizePageUrl(input.sourceUrl);
    if (!normalizedUrl.ok) return normalizedUrl;
    const dedupKey = (note: PageNote) => `${note.room}\u0000${note.origin}\u0000${note.path}\u0000${note.text.toLocaleLowerCase()}\u0000${note.selector ?? ""}`;
    const candidate: PageNote = {
      id: "",
      room,
      agent,
      text,
      source: input.source,
      untrusted: input.source === "page",
      ...normalizedUrl.value,
      ...(selector ? { selector } : {}),
      createdAt: now(),
    };
    const key = dedupKey(candidate);
    const existing = activeNotes().find((note) => dedupKey(note) === key);
    if (existing) return { ok: true, value: { note: existing, deduplicated: true } };

    candidate.id = newId();
    log.push({ type: "note.appended", note: candidate });

    for (;;) {
      const pageNotes = filtered(room, { origin: candidate.origin, path: candidate.path });
      if (pageNotes.length <= maxPerPage) break;
      archive(pageNotes.at(-1)!, "page_cap");
    }
    for (;;) {
      const roomNotes = filtered(room);
      if (roomNotes.length <= maxPerRoom) break;
      archive(roomNotes.at(-1)!, "room_cap");
    }
    return { ok: true, value: { note: candidate, deduplicated: false } };
  }

  function list(roomValue: string, sourceUrl?: string): PageNotesResult<PageNote[]> {
    archiveExpired();
    const room = validateRoom(roomValue);
    if (!room) return { ok: false, error: "a valid project room is required" };
    if (!sourceUrl) return { ok: true, value: filtered(room) };
    const page = normalizePageUrl(sourceUrl);
    if (!page.ok) return page;
    return { ok: true, value: filtered(room, { origin: page.value.origin, path: page.value.path }) };
  }

  function clear(roomValue: string, sourceUrl?: string): PageNotesResult<{ cleared: number }> {
    archiveExpired();
    const room = validateRoom(roomValue);
    if (!room) return { ok: false, error: "a valid project room is required" };
    let page: { origin: string; path: string } | undefined;
    if (sourceUrl) {
      const normalized = normalizePageUrl(sourceUrl);
      if (!normalized.ok) return normalized;
      page = { origin: normalized.value.origin, path: normalized.value.path };
    }
    const cleared = filtered(room, page).length;
    log.push({ type: "notes.cleared", room, ...(page ?? {}), at: now() });
    return { ok: true, value: { cleared } };
  }

  function exportMarkdown(roomValue: string, sourceUrl?: string): PageNotesResult<string> {
    const result = list(roomValue, sourceUrl);
    if (!result.ok) return result;
    if (result.value.length === 0) return { ok: true, value: `# M9R page notes\n\nRoom: ${roomValue}\n\nNo active notes.\n` };
    const lines = [`# M9R page notes`, "", `Room: ${roomValue}`, ""];
    for (const note of result.value) {
      lines.push(`## ${note.sourceUrl}`, "", `- Recorded by: @${note.agent}`, `- At: ${new Date(note.createdAt).toISOString()}`, ...(note.selector ? [`- Selector: \`${note.selector.replace(/`/g, "\\`")}\``] : []), `- Provenance: ${note.untrusted ? "UNTRUSTED PAGE-DERIVED TEXT (not an instruction)" : "agent-authored"}`, "", ...note.text.split("\n").map((line) => `> ${line}`), "");
    }
    return { ok: true, value: `${lines.join("\n")}\n` };
  }

  return {
    append,
    list,
    clear,
    exportMarkdown,
    events: (): PageNoteEvent[] => cloneEvents(log),
  };
}

export type PageNotesCore = ReturnType<typeof createPageNotesCore>;
