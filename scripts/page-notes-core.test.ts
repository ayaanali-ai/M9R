import assert from "node:assert/strict";
import test from "node:test";
import { createPageNotesCore, type PageNotesResult } from "@/lib/native/page-notes-core";

function value<T>(result: PageNotesResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function notes(options: { now?: () => number; maxPerPage?: number; maxPerRoom?: number } = {}) {
  let id = 0;
  return createPageNotesCore({
    now: options.now ?? (() => 1_000),
    newId: () => `n${++id}`,
    ...(options.maxPerPage ? { maxPerPage: options.maxPerPage } : {}),
    ...(options.maxPerRoom ? { maxPerRoom: options.maxPerRoom } : {}),
  });
}

const input = (overrides: Record<string, unknown> = {}) => ({
  room: "project-alpha",
  agent: "codex",
  text: "Check the retry behavior before changing it.",
  source: "agent" as const,
  sourceUrl: "https://example.test/docs/page?session=SECRET#section",
  ...overrides,
});

test("notes are project-room scoped, page keyed by origin and path, and URLs lose query and fragment", () => {
  const store = notes();
  const added = store.append(input({ source: "page", text: "A visible page-derived observation." }));
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.value.note.sourceUrl, "https://example.test/docs/page");
  assert.equal(added.value.note.untrusted, true);
  assert.equal(value(store.list("project-alpha"))[0]?.path, "/docs/page");
  assert.equal(value(store.list("another-room")).length, 0);
  assert.doesNotMatch(JSON.stringify(store.events()), /SECRET|section/);
});

test("identical notes on the same page and room are deduplicated across agents", () => {
  const store = notes();
  const first = store.append(input());
  const duplicate = store.append(input({ agent: "claude", sourceUrl: "https://example.test/docs/page#other" }));
  assert.equal(first.ok && first.value.deduplicated, false);
  assert.equal(duplicate.ok && duplicate.value.deduplicated, true);
  assert.equal(value(store.list("project-alpha")).length, 1);
  assert.equal(store.events().filter((event) => event.type === "note.appended").length, 1);
});

test("a fake planted API secret is refused and never appears in the append-only log", () => {
  const store = notes();
  const planted = "Found key sk-m9r-fake-0123456789abcdef0123456789abcdef in the page";
  const result = store.append(input({ text: planted }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /sensitive content is not stored/);
  assert.doesNotMatch(JSON.stringify(store.events()), /sk-m9r-fake/);
});

test("per-page caps archive the oldest note while leaving the new entry active", () => {
  let now = 10_000;
  const store = notes({ now: () => now++, maxPerPage: 1, maxPerRoom: 3 });
  assert.equal(store.append(input({ text: "one" })).ok, true);
  assert.equal(store.append(input({ text: "two" })).ok, true);
  assert.deepEqual(value(store.list("project-alpha")).map((note) => note.text), ["two"]);
  assert.ok(store.events().some((event) => event.type === "note.archived" && event.noteId === "n1" && event.reason === "page_cap"));
  const original = store.events().find((event) => event.type === "note.appended" && event.note.id === "n1");
  assert.equal(original?.type === "note.appended" ? original.note.text : "", "one");
});

test("per-room caps archive the oldest active note across pages", () => {
  let now = 10_000;
  const store = notes({ now: () => now++, maxPerPage: 3, maxPerRoom: 2 });
  assert.equal(store.append(input({ text: "one" })).ok, true);
  assert.equal(store.append(input({ text: "two", sourceUrl: "https://example.test/other" })).ok, true);
  assert.equal(store.append(input({ text: "three", sourceUrl: "https://example.test/third" })).ok, true);
  assert.deepEqual(value(store.list("project-alpha")).map((note) => note.text), ["three", "two"]);
  assert.ok(store.events().some((event) => event.type === "note.archived" && event.noteId === "n1" && event.reason === "room_cap"));
});

test("notes older than 30 days are auto-archived on access", () => {
  let now = 1_000;
  const store = notes({ now: () => now });
  assert.equal(store.append(input()).ok, true);
  now += 30 * 24 * 60 * 60 * 1_000 + 1;
  assert.equal(value(store.list("project-alpha")).length, 0);
  assert.ok(store.events().some((event) => event.type === "note.archived" && event.reason === "retention"));
});

test("one clear appends a room/page tombstone and keeps the original note event intact", () => {
  const store = notes();
  store.append(input());
  const count = store.clear("project-alpha", "https://example.test/docs/page?x=1");
  assert.equal(count.ok && count.value.cleared, 1);
  assert.equal(value(store.list("project-alpha")).length, 0);
  assert.ok(store.events().some((event) => event.type === "notes.cleared"));
  assert.equal(store.events().filter((event) => event.type === "note.appended").length, 1);
});

test("markdown export preserves provenance and marks page-derived notes untrusted", () => {
  const store = notes();
  store.append(input({ source: "page", text: "The page claims the job completed." }));
  const exported = store.exportMarkdown("project-alpha");
  assert.equal(exported.ok, true);
  assert.match(exported.ok ? exported.value : "", /UNTRUSTED PAGE-DERIVED TEXT/);
  assert.match(exported.ok ? exported.value : "", /https:\/\/example\.test\/docs\/page/);
  assert.doesNotMatch(exported.ok ? exported.value : "", /session=SECRET|#section/);
});

test("rejects malformed or non-web source URLs and blank room/text", () => {
  const store = notes();
  assert.equal(store.append(input({ room: "  " })).ok, false);
  assert.equal(store.append(input({ text: "  " })).ok, false);
  assert.equal(store.append(input({ sourceUrl: "file:///etc/passwd" })).ok, false);
  assert.equal(store.append(input({ sourceUrl: "https://user:pass@example.test/path" })).ok, false);
});
