import assert from "node:assert/strict";
import test from "node:test";
import { findMemoryHints, renderMemoryHint } from "../src/lib/native/memory-hint-core";
import { handleHookEvent } from "../src/lib/native/hook-handler";
import { createLocalStore } from "../src/lib/native/local-store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = [
  "# Memory index", "",
  "- 2026-09-20 Claude Code: Fix the lease renewal race in the relay [relay/lease.ts, relay/lease.test.ts] -> local/claude-code/s1.summary.md",
  "- 2026-09-19 Codex: Restyle the pricing page copy [src/app/pricing/page.tsx] -> local/codex/s2.summary.md",
  "",
].join("\n");

test("a prompt naming a file an earlier session changed gets a pointer to that summary", () => {
  const hints = findMemoryHints("can you look at relay/lease.ts, it seems flaky", INDEX);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /lease renewal race/);
  assert.match(hints[0], /\.oathlock\/memory\/local\/claude-code\/s1\.summary\.md/);
});

test("a bare file name matches, and unrelated prompts inject nothing", () => {
  assert.equal(findMemoryHints("why does lease.ts fail on restart", INDEX).length, 1);
  assert.deepEqual(findMemoryHints("What is 2+2?", INDEX), []);
  assert.deepEqual(findMemoryHints("please fix the thing", INDEX), []);
  assert.equal(renderMemoryHint([]), "");
});

test("never more than two hints, and never from a malformed index", () => {
  const many = Array.from({ length: 5 }, (_, i) => `- 2026-09-2${i} Codex: lease renewal work [relay/lease.ts] -> local/codex/s${i}.summary.md`).join("\n");
  assert.equal(findMemoryHints("relay/lease.ts", many).length, 2);
  assert.deepEqual(findMemoryHints("relay/lease.ts", "garbage\n- not a line"), []);
});

test("the UserPromptSubmit hook adds the hint only on a match, and stays silent otherwise", () => {
  const store = createLocalStore(mkdtempSync(join(tmpdir(), "m9r-hint-")));
  const ctx = { provider: "claude-code", store, readIndex: () => INDEX, pathExists: () => false };
  const hit = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "C:/p", prompt: "debug relay/lease.ts please" }, ctx);
  assert.match(hit?.hookSpecificOutput.additionalContext ?? "", /M9R memory:[\s\S]*lease renewal race/);
  const miss = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "C:/p", prompt: "what is 2+2" }, ctx);
  assert.equal(miss, null);
});
