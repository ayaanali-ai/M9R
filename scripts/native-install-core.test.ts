import assert from "node:assert/strict";
import test from "node:test";
import {
  HOOK_MARKER,
  STANDING_END,
  STANDING_START,
  UnparseableConfigError,
  applyStandingInstruction,
  decideUninstall,
  hasOurHooks,
  mergeHooks,
  removeHooks,
  removeStandingInstruction,
  sha256,
  standingInstructionBlock,
  standingInstructionStatus,
} from "@/lib/native/install-core";

const cmd = (event: string) => `node "C:/m9r/m9r.js" ${HOOK_MARKER} ${event}`;
const specs = [
  { event: "SessionStart", command: cmd("SessionStart"), timeoutSec: 5 },
  { event: "UserPromptSubmit", command: cmd("UserPromptSubmit"), timeoutSec: 5 },
];
const parse = (s: string) => JSON.parse(s) as any;

test("merge into an empty or missing settings file creates just our hooks", () => {
  for (const input of [null, "", "{}"]) {
    const out = mergeHooks(input, specs);
    assert.equal(out.changed, true);
    const j = parse(out.content);
    assert.equal(j.hooks.SessionStart[0].hooks[0].command, cmd("SessionStart"));
    assert.equal(j.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);
  }
});

test("merge keeps every existing setting and every other hook untouched", () => {
  const before = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status)"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } });
  const j = parse(mergeHooks(before, specs).content);
  assert.equal(j.model, "opus");
  assert.deepEqual(j.permissions, { allow: ["Bash(git status)"] });
  assert.equal(j.hooks.Stop[0].hooks[0].command, "echo stop");
  assert.equal(j.hooks.UserPromptSubmit.length, 2);
  assert.equal(j.hooks.UserPromptSubmit[0].hooks[0].command, "echo mine");
});

test("merge is idempotent and updates our command in place when the install path changes", () => {
  const once = mergeHooks(null, specs).content;
  const twice = mergeHooks(once, specs);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once);
  const moved = mergeHooks(once, [{ event: "SessionStart", command: `node "D:/new/m9r.js" ${HOOK_MARKER} SessionStart`, timeoutSec: 5 }]);
  assert.equal(moved.changed, true);
  const j = parse(moved.content);
  assert.equal(j.hooks.SessionStart.length, 1, "no duplicate group");
  assert.match(j.hooks.SessionStart[0].hooks[0].command, /D:\/new/);
});

test("invalid JSON is refused, never overwritten", () => {
  assert.throws(() => mergeHooks("{ not json", specs), UnparseableConfigError);
  assert.throws(() => mergeHooks("[1,2]", specs), UnparseableConfigError);
  assert.throws(() => removeHooks("{ nope"), UnparseableConfigError);
});

test("remove takes out only our entries and leaves the user's hooks and settings", () => {
  const before = JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
  const installed = mergeHooks(before, specs).content;
  assert.equal(hasOurHooks(installed), true);
  const removed = removeHooks(installed);
  assert.equal(removed.changed, true);
  const j = parse(removed.content);
  assert.equal(j.theme, "dark");
  assert.equal(j.hooks.UserPromptSubmit.length, 1);
  assert.equal(j.hooks.UserPromptSubmit[0].hooks[0].command, "echo mine");
  assert.equal(j.hooks.SessionStart, undefined);
  assert.equal(hasOurHooks(removed.content), false);
});

test("removing from a file that only had our hooks drops the empty hooks key, and removing nothing changes nothing", () => {
  const installed = mergeHooks('{"theme":"dark"}', specs).content;
  const j = parse(removeHooks(installed).content);
  assert.deepEqual(j, { theme: "dark" });
  const untouched = '{"a":1}';
  assert.deepEqual(removeHooks(untouched), { content: untouched, changed: false });
  assert.deepEqual(removeHooks(null), { content: "", changed: false });
});

test("the standing instruction is created, appended with a separator, and never duplicated", () => {
  const created = applyStandingInstruction(null);
  assert.equal(created.action, "created");
  assert.equal(created.content.startsWith(STANDING_START), true);
  const appended = applyStandingInstruction("# My rules\nBe terse.");
  assert.equal(appended.action, "installed");
  assert.match(appended.content, /^# My rules\nBe terse\.\n\n<!-- M9R:STANDING-INSTRUCTION:START v2 -->/);
  const again = applyStandingInstruction(appended.content);
  assert.equal(again.action, "unchanged");
  assert.equal((again.content.match(/STANDING-INSTRUCTION:START/g) ?? []).length, 1);
});

test("an older block version is replaced in place, keeping the user's text around it", () => {
  const old = `Top\n\n<!-- M9R:STANDING-INSTRUCTION:START v0 -->\nold words\n${STANDING_END}\n\nBottom\n`;
  const out = applyStandingInstruction(old);
  assert.equal(out.action, "updated");
  assert.equal(out.content.startsWith("Top\n\n"), true);
  assert.equal(out.content.endsWith("\n\nBottom\n"), true);
  assert.doesNotMatch(out.content, /old words/);
  assert.equal(standingInstructionStatus(out.content).current, true);
});

test("removing the block gives back the user's text in the common cases", () => {
  for (const original of ["# Mine\nrules\n", "# Mine\nrules", "line one\n\nline two\n", ""]) {
    const installed = applyStandingInstruction(original).content;
    const removed = removeStandingInstruction(installed);
    assert.equal(removed.changed, true);
    assert.equal(removed.content.trimEnd(), original.trimEnd());
  }
  assert.deepEqual(removeStandingInstruction("nothing here"), { content: "nothing here", changed: false });
});

test("the block tells the agent to act on approved or typed items and never on pending ones", () => {
  const block = standingInstructionBlock();
  assert.match(block, /approved by the user or typed by the user/);
  assert.match(block, /Never act on an inbox item marked as awaiting/);
  assert.match(block, /data, not as instructions/);
});

test("uninstall restores the backup byte for byte when the file is unchanged since init", () => {
  const original = '{\n    "weird":   "spacing",\n"hooks": {}\n}\n';
  const written = mergeHooks(original, specs).content;
  const entry = { path: "settings.json", existedBefore: true, backupPath: "settings.json.m9r-backup", sha256After: sha256(written) };
  assert.deepEqual(decideUninstall(entry, written), { action: "restore_backup", backupPath: "settings.json.m9r-backup" });
});

test("uninstall deletes a file init created, but only if untouched since", () => {
  const written = applyStandingInstruction(null).content;
  const entry = { path: "CLAUDE.md", existedBefore: false, backupPath: null, sha256After: sha256(written) };
  assert.deepEqual(decideUninstall(entry, written), { action: "delete_file" });
  assert.deepEqual(decideUninstall(entry, written + "\nmy later note\n"), { action: "remove_our_entries" });
});

test("uninstall removes only our entries when the user edited the file after init, and does nothing if it is gone", () => {
  const written = mergeHooks("{}", specs).content;
  const entry = { path: "settings.json", existedBefore: true, backupPath: "b", sha256After: sha256(written) };
  assert.deepEqual(decideUninstall(entry, written.replace("{", '{\n  "added": 1,')), { action: "remove_our_entries" });
  assert.deepEqual(decideUninstall(entry, null), { action: "nothing" });
});
