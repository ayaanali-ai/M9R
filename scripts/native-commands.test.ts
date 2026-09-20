import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeStatus, nativePaths, runNativeCommand, type NativeIo } from "@/lib/native/native-commands";
import { createLocalStore } from "@/lib/native/local-store";
import { ONBOARDING_STEPS, renderStepsMarkdown } from "@/lib/native/onboarding-steps";

function sandbox(opts: { confirm?: boolean | "none" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "m9r-home-"));
  const hookEntry = join(home, "m9r-hook.js");
  writeFileSync(hookEntry, "// stand-in hook program", "utf8");
  const out: string[] = [];
  const err: string[] = [];
  const io: NativeIo = {
    homeDir: home,
    env: { M9R_HOME: join(home, ".m9r"), CLAUDE_CONFIG_DIR: join(home, ".claude"), M9R_HOOK_ENTRY: hookEntry },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    confirm: opts.confirm === "none" ? undefined : async () => opts.confirm !== false,
  };
  const p = nativePaths(io);
  return { home, io, out, err, p, run: (cmd: string, args: string[] = []) => runNativeCommand(cmd, args, io), done: () => rmSync(home, { recursive: true, force: true }) };
}

test("a dry run shows the plan and writes nothing at all", async () => {
  const s = sandbox();
  const code = await s.run("setup", ["--dry-run"]);
  assert.equal(code, 0);
  assert.equal(existsSync(s.p.settings), false);
  assert.equal(existsSync(s.p.claudeMd), false);
  assert.equal(existsSync(s.p.manifest), false);
  assert.match(s.out.join("\n"), /add 2 hooks/);
  assert.match(s.out.join("\n"), /Dry run: nothing was written/);
  s.done();
});

test("setup with consent writes the hooks and the standing block, backs up existing files and records a manifest", async () => {
  const s = sandbox();
  mkdirSync(s.p.claude, { recursive: true });
  const original = '{\n    "model":   "opus",\n  "hooks": {}\n}\n';
  writeFileSync(s.p.settings, original, "utf8");
  writeFileSync(s.p.claudeMd, "# My rules\nBe terse.\n", "utf8");
  assert.equal(await s.run("setup", ["--yes"]), 0);
  const settings = JSON.parse(readFileSync(s.p.settings, "utf8"));
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command.includes("m9r-hook"), true);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.match(readFileSync(s.p.claudeMd, "utf8"), /^# My rules\nBe terse\.\n\n<!-- M9R:STANDING-INSTRUCTION:START/);
  assert.equal(readdirSync(s.p.backups).length, 2);
  assert.equal(JSON.parse(readFileSync(s.p.manifest, "utf8")).entries.length, 2);
  s.done();
});

test("without --yes it asks, and a no changes nothing", async () => {
  const s = sandbox({ confirm: false });
  assert.equal(await s.run("setup"), 1);
  assert.equal(existsSync(s.p.settings), false);
  assert.match(s.out.join("\n"), /Nothing was changed/);
  s.done();
});

test("with no terminal and no --yes it refuses instead of guessing", async () => {
  const s = sandbox({ confirm: "none" });
  assert.equal(await s.run("setup"), 1);
  assert.match(s.err.join("\n"), /Run again with --yes/);
  assert.equal(existsSync(s.p.settings), false);
  s.done();
});

test("running setup twice changes nothing the second time and keeps the original backup", async () => {
  const s = sandbox();
  mkdirSync(s.p.claude, { recursive: true });
  writeFileSync(s.p.settings, '{"a":1}', "utf8");
  await s.run("setup", ["--yes"]);
  const backupsAfterFirst = readdirSync(s.p.backups).sort();
  const before = readFileSync(s.p.settings, "utf8");
  s.out.length = 0;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.match(s.out.join("\n"), /Already set up/);
  assert.equal(readFileSync(s.p.settings, "utf8"), before);
  assert.deepEqual(readdirSync(s.p.backups).sort(), backupsAfterFirst);
  s.done();
});

test("an unparseable settings file stops the whole run before anything is written", async () => {
  const s = sandbox();
  mkdirSync(s.p.claude, { recursive: true });
  writeFileSync(s.p.settings, "{ this is not json", "utf8");
  assert.equal(await s.run("setup", ["--yes"]), 1);
  assert.match(s.err.join("\n"), /not valid JSON/);
  assert.equal(readFileSync(s.p.settings, "utf8"), "{ this is not json");
  assert.equal(existsSync(s.p.claudeMd), false, "the other file was not written either");
  assert.equal(existsSync(s.p.manifest), false);
  s.done();
});

test("uninstall restores every file byte for byte, and deletes files that setup created", async () => {
  const s = sandbox();
  mkdirSync(s.p.claude, { recursive: true });
  const original = '{\n    "weird":   "spacing",\n"theme": "dark"\n}\n';
  writeFileSync(s.p.settings, original, "utf8"); // CLAUDE.md does not exist yet
  await s.run("setup", ["--yes"]);
  assert.equal(existsSync(s.p.claudeMd), true);
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(readFileSync(s.p.settings, "utf8"), original);
  assert.equal(existsSync(s.p.claudeMd), false);
  assert.equal(existsSync(s.p.manifest), false);
  s.done();
});

test("uninstall keeps edits the user made after setup and removes only M9R's entries", async () => {
  const s = sandbox();
  mkdirSync(s.p.claude, { recursive: true });
  writeFileSync(s.p.claudeMd, "# Mine\n", "utf8");
  await s.run("setup", ["--yes"]);
  writeFileSync(s.p.claudeMd, readFileSync(s.p.claudeMd, "utf8") + "\nA note I added later.\n", "utf8");
  const settings = JSON.parse(readFileSync(s.p.settings, "utf8"));
  settings.theme = "light";
  writeFileSync(s.p.settings, JSON.stringify(settings), "utf8");
  await s.run("uninstall", ["--yes"]);
  const md = readFileSync(s.p.claudeMd, "utf8");
  assert.match(md, /A note I added later/);
  assert.doesNotMatch(md, /STANDING-INSTRUCTION/);
  const after = JSON.parse(readFileSync(s.p.settings, "utf8"));
  assert.equal(after.theme, "light");
  assert.equal(after.hooks, undefined);
  s.done();
});

test("uninstall with nothing installed says so and does nothing; --purge also removes local data", async () => {
  const s = sandbox();
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.match(s.out.join("\n"), /Nothing to uninstall/);
  await s.run("setup", ["--yes"]);
  createLocalStore(s.p.m9r).addTask({ from: "you", to: "claude", goal: "x", origin: "human_typed", idempotencyKey: "k" });
  await s.run("uninstall", ["--yes", "--purge"]);
  assert.equal(existsSync(s.p.m9r), false);
  s.done();
});

test("send creates a task for the agent, once per key, and rejects an empty message", async () => {
  const s = sandbox();
  assert.equal(await s.run("send", ["@claude", "review", "lease.ts", "--from", "codex", "--key", "same"]), 0);
  assert.match(s.out.join("\n"), /Sent to @claude as task T1/);
  const t = createLocalStore(s.p.m9r).tasksFor("claude");
  assert.equal(t.length, 1);
  assert.equal(t[0].goal, "review lease.ts");
  assert.equal(t[0].from, "codex");
  s.out.length = 0;
  await s.run("send", ["@claude", "review", "lease.ts", "--from", "codex", "--key", "same"]);
  assert.match(s.out.join("\n"), /Already sent/);
  assert.equal(createLocalStore(s.p.m9r).tasksFor("claude").length, 1);
  assert.equal(await s.run("send", ["@claude"]), 1);
  s.done();
});

test("status shows what is missing before setup and what is in place after", async () => {
  const s = sandbox();
  const before = nativeStatus(s.io);
  assert.equal(before.find((r) => r.id === "claude-hooks")?.state, "todo");
  assert.equal(before.find((r) => r.id === "claude-hooks")?.fix, "m9r-cli setup");
  assert.equal(before.find((r) => r.id === "standing")?.state, "todo");
  await s.run("setup", ["--yes"]);
  const after = nativeStatus(s.io);
  assert.equal(after.find((r) => r.id === "claude-hooks")?.state, "ok");
  assert.equal(after.find((r) => r.id === "standing")?.state, "ok");
  assert.equal(after.find((r) => r.id === "hook-entry")?.state, "ok");
  s.out.length = 0;
  await s.run("setup", ["--status"]);
  assert.match(s.out.join("\n"), /\[PASS\] Claude Code hooks installed/);
  assert.match(s.out.join("\n"), /\[YOU \] Trust the Codex hooks/);
  s.done();
});

test("the step list is the single source: every user-only step has a fix and the markdown lists them all", () => {
  for (const step of ONBOARDING_STEPS.filter((x) => x.who === "you" && x.id !== "logins")) assert.ok(step.fix, `${step.id} needs a fix line`);
  const md = renderStepsMarkdown();
  for (const step of ONBOARDING_STEPS) assert.ok(md.includes(step.title), `${step.id} missing from the markdown`);
});

// ---- the hook program is copied into M9R's own folder (so `npx` cache cleanups cannot kill the hooks) ---------------

function runtimeSandbox() {
  const home = mkdtempSync(join(tmpdir(), "m9r-rt-"));
  const source = join(home, "cli-dist");
  mkdirSync(source, { recursive: true });
  for (const f of ["m9r-hook.js", "local-store.js", "hook-handler.js", "inbox-core.js", "mention-core.js", "memory-hint-core.js"]) writeFileSync(join(source, f), `// ${f} v1\n`, "utf8");
  const out: string[] = [];
  const err: string[] = [];
  const io: NativeIo = { homeDir: home, env: { M9R_HOME: join(home, ".m9r"), CLAUDE_CONFIG_DIR: join(home, ".claude"), M9R_HOOK_SOURCE: source }, out: (l) => out.push(l), err: (l) => err.push(l) };
  const p = nativePaths(io);
  return { home, source, io, out, err, p, bin: join(p.m9r, "bin"), run: (cmd: string, args: string[] = []) => runNativeCommand(cmd, args, io), done: () => rmSync(home, { recursive: true, force: true }) };
}

test("setup copies the hook program into ~/.m9r/bin and points the hooks there, not at where the CLI happens to live", async () => {
  const s = runtimeSandbox();
  assert.equal(await s.run("setup", ["--yes"]), 0);
  for (const f of ["m9r-hook.js", "local-store.js", "hook-handler.js", "inbox-core.js", "mention-core.js", "memory-hint-core.js", "package.json"]) assert.equal(existsSync(join(s.bin, f)), true, f);
  assert.equal(JSON.parse(readFileSync(join(s.bin, "package.json"), "utf8")).type, "module");
  const command: string = JSON.parse(readFileSync(s.p.settings, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.equal(command.includes(s.bin.split(String.fromCharCode(92)).join("/")), true, command);
  assert.equal(command.includes("cli-dist"), false, "the hook must not point at the CLI's own location");
  assert.equal(JSON.parse(readFileSync(s.p.manifest, "utf8")).runtimeFiles.length, 7);
  s.done();
});

test("a second run changes nothing, and an updated CLI refreshes the copied program", async () => {
  const s = runtimeSandbox();
  await s.run("setup", ["--yes"]);
  s.out.length = 0;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.match(s.out.join("\n"), /Already set up/);
  writeFileSync(join(s.source, "hook-handler.js"), "// hook-handler.js v2\n", "utf8");
  s.out.length = 0;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.match(s.out.join("\n"), /copy the small hook program/);
  assert.equal(readFileSync(join(s.bin, "hook-handler.js"), "utf8"), "// hook-handler.js v2\n");
  s.done();
});

test("uninstall removes the copied hook program and its folder", async () => {
  const s = runtimeSandbox();
  await s.run("setup", ["--yes"]);
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(existsSync(s.bin), false);
  assert.equal(existsSync(s.p.manifest), false);
  s.done();
});

test("if the hook program is missing next to the CLI, setup refuses and writes nothing", async () => {
  const s = runtimeSandbox();
  rmSync(join(s.source, "mention-core.js"));
  assert.equal(await s.run("setup", ["--yes"]), 1);
  assert.match(s.err.join("\n"), /hook program is missing next to this CLI \(mention-core\.js\)/);
  assert.equal(existsSync(s.p.settings), false);
  assert.equal(existsSync(s.bin), false);
  s.done();
});

test("a dry run announces the copy and writes nothing; status is open before setup and ok after", async () => {
  const s = runtimeSandbox();
  assert.equal(await s.run("setup", ["--dry-run"]), 0);
  assert.match(s.out.join("\n"), /copy the small hook program to/);
  assert.equal(existsSync(s.bin), false);
  assert.equal(nativeStatus(s.io).find((r) => r.id === "hook-entry")?.state, "todo");
  await s.run("setup", ["--yes"]);
  assert.equal(nativeStatus(s.io).find((r) => r.id === "hook-entry")?.state, "ok");
  s.done();
});
