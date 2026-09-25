import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/mention-logic.js", import.meta.url), "utf8");

type Detected = { mentions: Array<{ handle: string; start: number; end: number; text: string }>; everyone: boolean; confidence: string | null };
function mentions() {
  const window: Record<string, unknown> = {};
  runInNewContext(source, { window, RegExp, Set, Array });
  return window.M9RMentions as {
    detect(text: string): Detected;
    resolveRecipients(text: string, sticky?: string[]): { handles: string[]; source: string; confidence: string | null };
  };
}
const handles = (text: string): string[] => JSON.parse(JSON.stringify(mentions().detect(text).mentions.map((m) => m.handle)));

test("a name at the start of the message addresses that agent", () => {
  assert.deepEqual(handles("Claude do X"), ["claude"]);
  assert.deepEqual(handles("codex read a.txt and tell me its first word"), ["codex"]);
  assert.deepEqual(handles("OpenCode, search for neovim"), ["opencode"]);
});

test("two-word names and a leading @ work", () => {
  assert.deepEqual(handles("Open code please read the page"), ["opencode"]);
  assert.deepEqual(handles("claude code fix this"), ["claude"]);
  assert.deepEqual(handles("@codex open the page"), ["codex"]);
});

test("several names in a row address all of them", () => {
  assert.deepEqual(handles("claude and codex, do this"), ["claude", "codex"]);
  assert.deepEqual(handles("Claude, Codex & OpenCode check the pricing page"), ["claude", "codex", "opencode"]);
});

test("everyone words address every agent", () => {
  for (const text of ["all three of you look at this", "everyone check the page", "All read the doc", "you all open it"]) {
    const found = mentions().detect(text);
    assert.equal(found.everyone, true, text);
  }
});

test("a friendly opener before the name is skipped", () => {
  assert.deepEqual(handles("Hey codex open the page"), ["codex"]);
  assert.deepEqual(handles("ok so claude, type it in"), ["claude"]);
});

test("each sentence can name a new agent", () => {
  assert.deepEqual(handles("opencode, search for x. Codex, then verify it."), ["opencode", "codex"]);
  assert.deepEqual(handles("Claude read the intro\ncodex open the history"), ["claude", "codex"]);
});

test("talking about an agent is not addressing it", () => {
  assert.deepEqual(handles("Claude's pricing is high"), []);
  assert.deepEqual(handles("what is Claude doing?"), []);
  assert.deepEqual(handles("Claude is slow today"), []);
  assert.deepEqual(handles("I asked codex about it earlier"), []);
  assert.deepEqual(handles("Codexes are everywhere"), []);
  assert.deepEqual(handles("the all-hands meeting"), []);
  assert.deepEqual(handles(""), []);
  assert.deepEqual(handles("   "), []);
});

test("Claude can you is still a request to Claude", () => {
  assert.deepEqual(handles("Claude can you open the page"), ["claude"]);
});

test("the range of each name points at the typed text so it can be shown as a chip", () => {
  const found = mentions().detect("Hey codex, open the page");
  assert.equal(found.mentions[0].text, "codex");
  assert.equal("Hey codex, open the page".slice(found.mentions[0].start, found.mentions[0].end), "codex");
});

test("a plain name with a comma or a command is confident, an unclear one is medium", () => {
  assert.equal(mentions().detect("Codex, the page is open").confidence, "high");
  assert.equal(mentions().detect("Claude open it").confidence, "high");
  assert.equal(mentions().detect("Claude the page looks off").confidence, "medium");
});

test("a message with no names carries on with the agents from the last message", () => {
  const m = mentions();
  assert.deepEqual(JSON.parse(JSON.stringify(m.resolveRecipients("now type it in the search box", ["claude", "codex"]))), { handles: ["claude", "codex"], source: "sticky", confidence: null });
  assert.deepEqual(JSON.parse(JSON.stringify(m.resolveRecipients("codex, verify that", ["claude"]))), { handles: ["codex"], source: "named", confidence: "high" });
  assert.deepEqual(JSON.parse(JSON.stringify(m.resolveRecipients("hello there", []))), { handles: [], source: "none", confidence: null });
  assert.deepEqual(JSON.parse(JSON.stringify(m.resolveRecipients("all three of you, stop", ["claude"]))), { handles: ["all"], source: "named", confidence: "high" });
});
