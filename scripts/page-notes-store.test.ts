import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPageNotesStore } from "@/lib/native/page-notes-store";

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

test("page notes survive a new store instance and persist only appended events", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-notes-store-"));
  try {
    const store = createPageNotesStore(root, { now: () => 10_000, newId: () => "n1" });
    const saved = store.append({ room: "repo", agent: "codex", text: "Check retry policy", source: "agent", sourceUrl: "https://example.test/p?q=private" });
    assert.equal(saved.ok, true);
    const beforeClear = readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
    assert.equal(beforeClear.length, 1);
    assert.doesNotMatch(beforeClear[0], /private/);

    const reopened = createPageNotesStore(root, { now: () => 20_000 });
    assert.equal(value(reopened.list("repo"))[0]?.text, "Check retry policy");
    assert.equal(value(reopened.clear("repo")).cleared, 1);
    const afterClear = readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
    assert.equal(afterClear.length, 2, "clear adds a tombstone line rather than rewriting the original note");
    assert.equal(afterClear[0], beforeClear[0]);
    assert.equal(value(createPageNotesStore(root).list("repo")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed append-only log fails closed instead of being replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-notes-store-corrupt-"));
  try {
    const file = join(root, "page-notes.jsonl");
    writeFileSync(file, "not-json\n", "utf8");
    assert.throws(() => createPageNotesStore(root).list("repo"), /corrupt at line 1; refusing to overwrite/);
    assert.equal(readFileSync(file, "utf8"), "not-json\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
