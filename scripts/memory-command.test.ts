import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findMemoryDir, rebuildMemory, runMemory } from "../src/lib/native/memory-command";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "m9r-memcmd-"));
  const mem = join(root, ".oathlock", "memory");
  mkdirSync(join(mem, "local", "codex"), { recursive: true });
  mkdirSync(join(mem, "Alice", "general"), { recursive: true });
  writeFileSync(join(mem, "local", "codex", "aaaa-1111.md"), ["# Codex session (aaaa)", "", "- Provider: Codex", "- Captured: 2026-09-18T10:00:00Z", `- Working directory: ${root}`, "- Session id: aaaa-1111", "", "---", "", "**User:**", "", "Add retry to the upload worker", "", "**Assistant:**", "", "Added exponential backoff, capped at 5 tries.", ""].join("\n"));
  writeFileSync(join(mem, "Alice", "general", "bbbb-2222.md"), ["# Standup", "", "- Owner: Alice", "- Channel: #general", "- Archived: 2026-09-19T09:00:00Z", "- Session id: bbbb-2222", "", "---", "", "**Alice:**", "", "Can someone check the billing webhook?", "", "**Codex:**", "", "Webhook signature check was missing; fixed.", ""].join("\n"));
  const lines: string[] = [];
  return { root, mem, lines, io: { cwd: root, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("with no memory folder it says how one gets created and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "m9r-nomem-"));
  const lines: string[] = [];
  assert.equal(runMemory([], { cwd: dir, out: (l) => lines.push(l), err: (l) => lines.push(l) }), 0);
  assert.match(lines.join("\n"), /capture install/);
  assert.equal(readdirSync(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("it prints the real path and counts, and asks for --rebuild while sessions have no summary", () => {
  const s = sandbox();
  assert.equal(findMemoryDir(join(s.root, "sub")) ?? findMemoryDir(s.root), s.mem);
  runMemory([], s.io);
  const text = s.lines.join("\n");
  assert.ok(text.includes(s.mem), "shows the absolute folder path");
  assert.match(text, /2 saved session transcript/);
  assert.match(text, /--rebuild/);
  assert.equal(existsSync(join(s.mem, "index.md")), false, "read-only without --rebuild");
  s.done();
});

test("--rebuild adds summaries and an index without touching any transcript, and is repeatable", () => {
  const s = sandbox();
  const before = readFileSync(join(s.mem, "local", "codex", "aaaa-1111.md"), "utf8");
  runMemory(["--rebuild"], s.io);
  assert.match(s.lines.join("\n"), /Wrote 2 new summaries/);
  assert.equal(readFileSync(join(s.mem, "local", "codex", "aaaa-1111.md"), "utf8"), before);
  const summary = readFileSync(join(s.mem, "local", "codex", "aaaa-1111.summary.md"), "utf8");
  assert.match(summary, /Add retry to the upload worker/);
  assert.match(summary, /exponential backoff/);
  assert.match(summary, /not recorded for this older session/);
  const index = readFileSync(join(s.mem, "index.md"), "utf8");
  assert.match(index, /local\/codex\/aaaa-1111\.summary\.md/);
  assert.match(index, /Alice\/general\/bbbb-2222\.summary\.md/);
  assert.match(index, /Can someone check the billing webhook/);
  assert.deepEqual(rebuildMemory(s.mem), { summarised: 0, indexed: 2 });
  s.lines.length = 0;
  runMemory([], s.io);
  assert.match(s.lines.join("\n"), /Index \(what agents read first\)/);
  assert.doesNotMatch(s.lines.join("\n"), /older session\(s\) have no summary/);
  s.done();
});
