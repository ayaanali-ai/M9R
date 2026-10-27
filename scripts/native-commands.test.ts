import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HOOK_RUNTIME_FILES, createNativeDeliveryPump, nativeStatus, nativePaths, runNativeCommand, type NativeIo } from "@/lib/native/native-commands";
import { createLocalStore } from "@/lib/native/local-store";
import { createPageNotesStore } from "@/lib/native/page-notes-store";
import { projectRoomId } from "@/lib/native/project-room";
import { ONBOARDING_STEPS, renderStepsMarkdown } from "@/lib/native/onboarding-steps";
import { createRuntimeBuildInfo } from "@/lib/native/runtime-build-identity";

const autostartCalls: string[] = [];
let autostartOn = false;
const brokerAutostartCalls: string[] = [];
// Every test gets a fake: nothing here may ever touch the real Windows registry.
const fakeAutostart = { enable: (c: string) => { autostartCalls.push(`enable ${c}`); autostartOn = true; return true; }, disable: () => { autostartCalls.push("disable"); autostartOn = false; }, isOn: () => autostartOn };

function sandbox(opts: { confirm?: boolean | "none"; tempRoot?: string } = {}) {
  const tempRoot = opts.tempRoot ?? tmpdir();
  mkdirSync(tempRoot, { recursive: true });
  const home = mkdtempSync(join(tempRoot, "m9r-home-"));
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
    autostart: fakeAutostart,
    installLocalBrokerAutostart: async () => {
      brokerAutostartCalls.push("install");
      return { ok: true, message: "broker installed" };
    },
    removeLocalBrokerAutostart: async () => {
      brokerAutostartCalls.push("remove");
      return { ok: true, message: "broker removed" };
    },
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
  assert.match(s.out.join("\n"), /add 3 hooks/);
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

test("web identity-only setup installs selected provider hooks without registering the native MCP server", async () => {
  const s = sandbox();
  mkdirSync(s.p.codex, { recursive: true });
  assert.equal(await s.run("setup", ["--identity-only", "--agents", "codex", "--yes"]), 0);
  assert.equal(existsSync(s.p.codexHooks), true);
  assert.equal(existsSync(s.p.codexAgents), true);
  assert.equal(existsSync(s.p.codexConfig), false);
  assert.equal(existsSync(s.p.settings), false);
  const manifest = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { entries: Array<{ path: string; kind: string }> };
  assert.equal(manifest.entries.every((entry) => entry.kind !== "mcp-toml" && !entry.path.endsWith("settings.json")), true);
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

test("pill sends from the install folder retain the owner's configured project", async () => {
  const s = sandbox();
  try {
    mkdirSync(s.p.m9r, { recursive: true });
    const project = join(s.home, "project");
    s.io.cwd = join(s.p.m9r, "bin");
    writeFileSync(join(s.p.m9r, "broker-autostart.json"), JSON.stringify({ projectRoot: project }));
    await s.run("send", ["@opencode", "show your cursor"]);
    assert.equal(createLocalStore(s.p.m9r).tasksFor("opencode")[0]?.cwd, project);
  } finally { s.done(); }
});

test("pill sends launched from Windows System32 retain the owner's configured project", async () => {
  const s = sandbox();
  try {
    mkdirSync(s.p.m9r, { recursive: true });
    const project = join(s.home, "project");
    s.io.cwd = "C:\\WINDOWS\\System32";
    writeFileSync(join(s.p.m9r, "broker-autostart.json"), JSON.stringify({ projectRoot: project }));
    await s.run("send", ["@opencode", "show your cursor"]);
    assert.equal(createLocalStore(s.p.m9r).tasksFor("opencode")[0]?.cwd, project);
  } finally { s.done(); }
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

test("status flags provider sessions that cannot receive targeted delivery without a live identity", () => {
  const s = sandbox();
  const store = createLocalStore(s.p.m9r);
  store.registerEndpoint({ provider: "codex", sessionId: "codex-no-token", cwd: s.home });
  const missing = nativeStatus(s.io).find((row) => row.id === "target-identities");
  assert.equal(missing?.state, "todo");
  assert.match(missing?.label ?? "", /lack a live M9R identity/);
  store.issueIdentity("codex", "codex", "codex-no-token");
  const healthy = nativeStatus(s.io).find((row) => row.id === "target-identities");
  assert.equal(healthy?.state, "info", "a retained identity does not prove current-turn binding");
  assert.match(healthy?.label ?? "", /stored M9R identities.*current-turn binding is not verified/i);
  s.done();
});

test("status does not tell the owner to restart retained historical sessions", () => {
  const s = sandbox();
  const store = createLocalStore(s.p.m9r);
  store.registerEndpoint({ provider: "opencode", sessionId: "opencode-old", cwd: s.home, seenAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });

  const identity = nativeStatus(s.io).find((row) => row.id === "target-identities");
  assert.equal(identity?.state, "info");
  assert.match(identity?.label ?? "", /No recently active provider sessions/);
  assert.equal(identity?.fix, undefined);
  s.done();
});

test("status does not repeat first-time new-session guidance after an endpoint is known", async () => {
  const s = sandbox();
  createLocalStore(s.p.m9r).registerEndpoint({ provider: "opencode", sessionId: "opencode-existing", cwd: s.home });
  await s.run("setup", ["--status"]);

  assert.doesNotMatch(s.out.join("\n"), /Start a new Claude Code session/);
  s.out.length = 0;
  await s.run("setup", ["--yes"]);
  assert.doesNotMatch(s.out.join("\n"), /Start a new Claude Code session/);
  s.done();
});

test("status does not count expired or already-pushed history as waiting inbox work", () => {
  const s = sandbox();
  const store = createLocalStore(s.p.m9r);
  store.registerEndpoint({ provider: "codex", sessionId: "codex-status", cwd: s.home });
  const stale = store.addTask({ from: "you", to: "codex", goal: "old work", origin: "human_typed", idempotencyKey: "old-status" }).task;
  store.setDelivery(stale.id, { state: "queued", threadId: "codex-status" });
  const statePath = join(s.p.m9r, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { tasks: Array<{ id: string; createdAt: string }> };
  state.tasks.find((task) => task.id === stale.id)!.createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
  writeFileSync(statePath, JSON.stringify(state), "utf8");

  const pending = nativeStatus(s.io).find((row) => row.id === "pending");
  assert.equal(pending, undefined, "historical pushed work must not be shown as an inbox item");
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
  for (const f of HOOK_RUNTIME_FILES) writeFileSync(join(source, f), `// ${f} v1\n`, "utf8");
  const out: string[] = [];
  const err: string[] = [];
  const io: NativeIo = { homeDir: home, env: { M9R_HOME: join(home, ".m9r"), CLAUDE_CONFIG_DIR: join(home, ".claude"), M9R_HOOK_SOURCE: source }, out: (l) => out.push(l), err: (l) => err.push(l) };
  const p = nativePaths(io);
  return { home, source, io, out, err, p, bin: join(p.m9r, "bin"), run: (cmd: string, args: string[] = []) => runNativeCommand(cmd, args, io), done: () => rmSync(home, { recursive: true, force: true }) };
}

test("setup copies the hook program into ~/.m9r/bin and points the hooks there, not at where the CLI happens to live", async () => {
  const s = runtimeSandbox();
  assert.equal(await s.run("setup", ["--yes"]), 0);
  for (const f of [...HOOK_RUNTIME_FILES, "package.json"]) assert.equal(existsSync(join(s.bin, f)), true, f);
  assert.equal(JSON.parse(readFileSync(join(s.bin, "package.json"), "utf8")).type, "module");
  const command: string = JSON.parse(readFileSync(s.p.settings, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.equal(command.includes(s.bin.split(String.fromCharCode(92)).join("/")), true, command);
  assert.equal(command.includes("cli-dist"), false, "the hook must not point at the CLI's own location");
  assert.equal(JSON.parse(readFileSync(s.p.manifest, "utf8")).runtimeFiles.length, HOOK_RUNTIME_FILES.length + 1);
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

test("when Codex is installed, setup also adds its hooks and standing block, keeps the user's own hook, and uninstall restores every file exactly", async () => {
  const s = sandbox();
  const codex = s.p.codex;
  mkdirSync(codex, { recursive: true });
  const ownHooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node my-own-hook.js" }] }] } }, null, 2) + "\n";
  writeFileSync(s.p.codexHooks, ownHooks, "utf8");
  writeFileSync(s.p.codexAgents, "# Codex rules\nBe brief.\n", "utf8");
  assert.equal(await s.run("setup", ["--yes"]), 0);
  const hooks = JSON.parse(readFileSync(s.p.codexHooks, "utf8"));
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, "node my-own-hook.js", "the user's own hook is untouched");
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /m9r-hook.* UserPromptSubmit codex$/);
  assert.match(hooks.hooks.Interrupt[0].hooks[0].command, /m9r-hook.* Interrupt codex$/);
  assert.match(hooks.hooks.SessionEnd[0].hooks[0].command, /m9r-hook.* SessionEnd codex$/);
  assert.match(readFileSync(s.p.codexAgents, "utf8"), /^# Codex rules\nBe brief\.\n\n<!-- M9R:STANDING-INSTRUCTION:START/);
  assert.equal(nativeStatus(s.io).find((r) => r.id === "codex-hooks")?.state, "ok");
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(readFileSync(s.p.codexHooks, "utf8"), ownHooks);
  assert.equal(readFileSync(s.p.codexAgents, "utf8"), "# Codex rules\nBe brief.\n");
  s.done();
});

test("without Codex installed, setup never creates its folder", async () => {
  const s = sandbox();
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.equal(existsSync(s.p.codex), false);
  assert.equal(nativeStatus(s.io).some((r) => r.id === "codex-hooks"), false);
  s.done();
});

test("with the engine, setup copies it into M9R's folder and the hooks call it (no node needed), and uninstall removes it", async () => {
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  const installed = join(s.p.m9r, "bin", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");
  assert.equal(readFileSync(installed, "utf8"), "stand-in engine");
  const settings = readFileSync(s.p.settings, "utf8");
  assert.match(settings, /m9r-engine(.exe)?.{1,2} m9r-hook UserPromptSubmit claude-code/);
  assert.doesNotMatch(settings, /"node /);
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.match(s.out.join("\n"), /Already set up/);
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(existsSync(installed), false);
  s.done();
});

test("setup records verified runtime provenance and repairs stale active-runtime metadata without restarting the daemon", async () => {
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  const engineBytes = Buffer.from("verified stand-in engine", "utf8");
  writeFileSync(engine, engineBytes);
  const engineHash = createHash("sha256").update(engineBytes).digest("hex");
  writeFileSync(join(s.home, "m9r-build-info.json"), JSON.stringify(createRuntimeBuildInfo(
    { "m9r-engine.exe": engineHash },
    "2026-10-16T00:00:00.000Z",
    { sourceCommit: "source-commit-1", sourceDirty: false },
  )));
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";

  assert.equal(await s.run("setup", ["--yes"]), 0);
  const first = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { activeRuntime?: { buildId: string; sourceCommit: string; sourceDirty: boolean; installedRoot: string; stateRoot: string } };
  assert.equal(first.activeRuntime?.sourceCommit, "source-commit-1");
  assert.equal(first.activeRuntime?.sourceDirty, false);
  assert.equal(first.activeRuntime?.installedRoot, join(s.p.m9r, "bin"));
  assert.equal(first.activeRuntime?.stateRoot, s.p.m9r);

  first.activeRuntime!.sourceCommit = "stale-commit";
  writeFileSync(s.p.manifest, JSON.stringify(first, null, 2) + "\n", "utf8");
  s.out.length = 0;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  const repaired = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { activeRuntime?: { sourceCommit: string } };
  assert.equal(repaired.activeRuntime?.sourceCommit, "source-commit-1");
  assert.match(s.out.join("\n"), /reconcile the verified installed runtime identity/i);
  s.done();
});

test("an engine update removes dead retired-image entries from the install ownership manifest", async () => {
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  writeFileSync(engine, "stand-in engine v1", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  assert.equal(await s.run("setup", ["--yes"]), 0);

  const bin = join(s.p.m9r, "bin");
  const missingRetired = join(bin, "m9r-engine.exe.m9r-retired-previous-missing");
  const removableRetired = join(bin, "m9r-engine.exe.m9r-retired-previous-unlocked");
  writeFileSync(removableRetired, "stale engine image", "utf8");
  const before = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { runtimeFiles: string[] };
  before.runtimeFiles.push(missingRetired, removableRetired);
  writeFileSync(s.p.manifest, JSON.stringify(before, null, 2) + "\n", "utf8");
  writeFileSync(engine, "stand-in engine v2", "utf8");

  assert.equal(await s.run("setup", ["--yes"]), 0);
  const after = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { runtimeFiles: string[] };
  assert.equal(readFileSync(join(bin, "m9r-engine.exe"), "utf8"), "stand-in engine v2");
  assert.equal(existsSync(removableRetired), false, "the runtime update prunes an unlocked retired image");
  assert.equal(after.runtimeFiles.includes(missingRetired), false, "missing retired images are removed from ownership metadata");
  assert.equal(after.runtimeFiles.includes(removableRetired), false, "pruned retired images are removed from ownership metadata");
  s.done();
});

test("a no-op setup retries cleanup of owned retired runtime images and reconciles their manifest entries", async () => {
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  assert.equal(await s.run("setup", ["--yes"]), 0);

  const bin = join(s.p.m9r, "bin");
  const retired = join(bin, "m9r-engine.exe.m9r-retired-previous-unlocked");
  writeFileSync(retired, "stale engine image", "utf8");
  const before = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { runtimeFiles: string[] };
  before.runtimeFiles.push(retired);
  writeFileSync(s.p.manifest, JSON.stringify(before, null, 2) + "\n", "utf8");

  s.out.length = 0;
  assert.equal(await s.run("setup", ["--dry-run"]), 0);
  assert.match(s.out.join("\n"), /retry cleanup of 1 M9R-owned retired runtime image/i);
  assert.equal(existsSync(retired), true, "dry-run never deletes a retired image");

  s.out.length = 0;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  const after = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { runtimeFiles: string[] };
  assert.equal(existsSync(retired), false, "an unlocked retired image is removed on no-op setup");
  assert.equal(after.runtimeFiles.includes(retired), false, "the stale ownership record is removed after deletion");
  assert.match(s.out.join("\n"), /removed 1 unlocked retired runtime image/i);
  s.done();
});

test("with the engine and the native hook side by side, the settings point at the small hook, both are copied, and uninstall removes both", async () => {
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  const shim = join(s.home, process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(shim, "stand-in native hook", "utf8");
  writeFileSync(join(s.home, "m9r-build-info.json"), "stand-in runtime manifest", "utf8");
  const nativeInputHost = join(s.home, "m9r-native-input-host.exe");
  if (process.platform === "win32") writeFileSync(nativeInputHost, "stand-in trusted input host", "utf8");
  const overlay = join(s.home, "m9r-overlay.exe");
  if (process.platform === "win32") writeFileSync(overlay, "stand-in pill overlay", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  const bin = join(s.p.m9r, "bin");
  assert.equal(readFileSync(join(bin, process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native"), "utf8"), "stand-in native hook");
  assert.equal(readFileSync(join(bin, "m9r-build-info.json"), "utf8"), "stand-in runtime manifest");
  if (process.platform === "win32") assert.equal(readFileSync(join(bin, "m9r-native-input-host.exe"), "utf8"), "stand-in trusted input host");
  if (process.platform === "win32") assert.equal(readFileSync(join(bin, "m9r-overlay.exe"), "utf8"), "stand-in pill overlay");
  assert.equal(readFileSync(join(bin, process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine"), "utf8"), "stand-in engine");
  const settings = readFileSync(s.p.settings, "utf8");
  assert.match(settings, /m9r-hook(\.exe|-native)?.{1,2} UserPromptSubmit claude-code/);
  assert.doesNotMatch(settings, /m9r-engine/);
  // A reinstall with a changed overlay binary must replace the stale copy, not leave it in place.
  if (process.platform === "win32") {
    writeFileSync(overlay, "stand-in pill overlay v2", "utf8");
    assert.equal(await s.run("setup", ["--yes"]), 0);
    assert.equal(readFileSync(join(bin, "m9r-overlay.exe"), "utf8"), "stand-in pill overlay v2");
  }
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(existsSync(join(bin, process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native")), false);
  assert.equal(existsSync(join(bin, "m9r-build-info.json")), false);
  if (process.platform === "win32") assert.equal(existsSync(join(bin, "m9r-native-input-host.exe")), false);
  if (process.platform === "win32") assert.equal(existsSync(join(bin, "m9r-overlay.exe")), false);
  s.done();
});

test("with the engine, setup registers the M9R MCP server for Claude at both effective scopes, keeps every other server, and uninstall removes only ours", async () => {
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  const shim = join(s.home, "m9r-hook.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(shim, "stand-in stable launcher", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  mkdirSync(s.p.codex, { recursive: true });
  mkdirSync(s.p.claude, { recursive: true });
  writeFileSync(s.p.codexConfig, "[mcp_servers.github]\ncommand = \"npx\"\nargs = [\"-y\", \"@modelcontextprotocol/server-github\"]\n", "utf8");
  writeFileSync(s.p.claudeMcp, JSON.stringify({ mcpServers: { other: { command: "npx", args: ["-y", "other-server"] } } }), "utf8");
  writeFileSync(s.p.claudeGlobalMcp, JSON.stringify({ mcpServers: {
    otherGlobal: { command: "npx", args: ["-y", "other-global-server"] },
    m9r: { command: engine, args: ["mcp"], env: { M9R_HOME: s.p.m9r }, },
  } }), "utf8");

  assert.equal(await s.run("setup", ["--yes"]), 0);

  const claudeMcp = JSON.parse(readFileSync(s.p.claudeMcp, "utf8"));
  assert.deepEqual(claudeMcp.mcpServers.other, { command: "npx", args: ["-y", "other-server"] }, "an already-registered server is left alone");
  assert.match(claudeMcp.mcpServers.m9r.command, /m9r-hook\.exe$/);
  assert.deepEqual(claudeMcp.mcpServers.m9r.args, ["mcp"]);
  assert.equal(claudeMcp.mcpServers.m9r.env.M9R_HOME, s.p.m9r);
  assert.equal(claudeMcp.mcpServers.m9r.env.M9R_WEB_BROKER_PORT, "47821");

  const claudeGlobalMcp = JSON.parse(readFileSync(s.p.claudeGlobalMcp, "utf8"));
  assert.deepEqual(claudeGlobalMcp.mcpServers.otherGlobal, { command: "npx", args: ["-y", "other-global-server"] }, "the user-level config preserves other servers");
  assert.match(claudeGlobalMcp.mcpServers.m9r.command, /m9r-hook\.exe$/);
  assert.deepEqual(claudeGlobalMcp.mcpServers.m9r.args, ["mcp"]);
  assert.equal(claudeGlobalMcp.mcpServers.m9r.env.M9R_PROVIDER, "claude-code");

  const codexConfig = readFileSync(s.p.codexConfig, "utf8");
  assert.match(codexConfig, /\[mcp_servers\.github\]/);
  assert.match(codexConfig, /\[mcp_servers\.m9r\]/);
  assert.match(codexConfig, /args = \["mcp"\]/);
  assert.match(codexConfig, /\[mcp_servers\.m9r\.env\]/);
  const tomlM9rHome = s.p.m9r.replace(/\\/g, "\\\\");
  assert.ok(codexConfig.includes(`M9R_HOME = "${tomlM9rHome}"`));
  assert.match(codexConfig, /M9R_WEB_BROKER_PORT = "47821"/);

  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.match(s.out.join("\n"), /Already set up/);

  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  const claudeMcpAfter = JSON.parse(readFileSync(s.p.claudeMcp, "utf8"));
  assert.ok(!("m9r" in claudeMcpAfter.mcpServers), "our entry is gone");
  assert.deepEqual(claudeMcpAfter.mcpServers.other, { command: "npx", args: ["-y", "other-server"] }, "the other server survives uninstall");
  const claudeGlobalAfter = JSON.parse(readFileSync(s.p.claudeGlobalMcp, "utf8"));
  assert.deepEqual(claudeGlobalAfter.mcpServers.m9r, { command: engine, args: ["mcp"], env: { M9R_HOME: s.p.m9r } }, "the pre-existing user-level M9R entry is restored exactly");
  assert.deepEqual(claudeGlobalAfter.mcpServers.otherGlobal, { command: "npx", args: ["-y", "other-global-server"] }, "the user-level other server survives uninstall");
  const codexConfigAfter = readFileSync(s.p.codexConfig, "utf8");
  assert.doesNotMatch(codexConfigAfter, /\[mcp_servers\.m9r\]/);
  assert.match(codexConfigAfter, /\[mcp_servers\.github\]/);
  s.done();
});

test("with the engine, native setup maintains OpenCode's MCP entry and identity plugin without touching other config", async () => {
  const s = sandbox();
  const p = s.p as typeof s.p & { opencodeConfig: string; opencodePlugin: string };
  const opencodeDirectory = join(s.home, ".config", "opencode");
  mkdirSync(opencodeDirectory, { recursive: true });
  writeFileSync(p.opencodeConfig, JSON.stringify({ mcp: { github: { type: "local", command: ["gh-mcp"] } }, theme: "dark" }, null, 2) + "\n", "utf8");

  const engine = join(s.home, "m9r-engine.exe");
  const shim = join(s.home, "m9r-hook.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(shim, "stand-in stable launcher", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  s.io.env.M9R_OPENCODE_VERSION = "1.19.0";

  assert.equal(await s.run("setup", ["--agents", "opencode", "--yes"]), 0);
  const config = JSON.parse(readFileSync(p.opencodeConfig, "utf8")) as {
    mcp: Record<string, { enabled?: boolean; command?: string[]; environment?: Record<string, string> }>;
    theme: string;
  };
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.mcp.github, { type: "local", command: ["gh-mcp"] });
  assert.equal(config.mcp.m9r.enabled, true);
  assert.deepEqual(config.mcp.m9r.command, [join(s.p.m9r, "bin", "m9r-hook.exe").replaceAll("\\", "/"), "mcp"]);
  assert.equal(config.mcp.m9r.environment?.M9R_PROVIDER, "opencode");
  assert.equal(existsSync(p.opencodePlugin), true);
  assert.match(readFileSync(p.opencodePlugin, "utf8"), /OpenCodePoll/);

  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  const after = JSON.parse(readFileSync(p.opencodeConfig, "utf8")) as {
    mcp: Record<string, { enabled?: boolean; command?: string[]; environment?: Record<string, string> }>;
    theme: string;
  };
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.mcp.github, { type: "local", command: ["gh-mcp"] });
  assert.equal("m9r" in after.mcp, false);
  assert.equal(existsSync(p.opencodePlugin), false);
  s.done();
});

test("native setup reconciles both OpenCode config spellings in the active directory", async () => {
  const s = sandbox();
  const opencodeDirectory = join(s.home, ".config", "opencode");
  mkdirSync(opencodeDirectory, { recursive: true });
  const modernPath = join(opencodeDirectory, "opencode.jsonc");
  const legacyPath = join(opencodeDirectory, "opencode.json");
  const modernBefore = JSON.stringify({ mcp: { github: { type: "local", command: ["gh-mcp"] } }, theme: "dark" }, null, 2) + "\n";
  const legacyBefore = JSON.stringify({ mcp: { m9r: { type: "local", command: ["old-m9r-engine", "mcp"], environment: { M9R_HOME: s.p.m9r } } }, theme: "dark" }, null, 2) + "\n";
  writeFileSync(modernPath, modernBefore, "utf8");
  writeFileSync(legacyPath, legacyBefore, "utf8");

  const engine = join(s.home, "m9r-engine.exe");
  const shim = join(s.home, "m9r-hook.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(shim, "stand-in stable launcher", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  s.io.env.M9R_OPENCODE_VERSION = "2.1.1";

  assert.equal(await s.run("setup", ["--agents", "opencode", "--yes"]), 0);
  for (const path of [modernPath, legacyPath]) {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      mcp: { servers?: Record<string, { enabled?: boolean; command?: string[]; environment?: Record<string, string> }>; m9r?: { enabled?: boolean; command?: string[]; environment?: Record<string, string> } };
      theme: string;
    };
    const m9r = config.mcp.servers?.m9r;
    assert.equal(config.theme, "dark");
    assert.equal(m9r?.enabled, true);
    assert.match(m9r?.command?.[0] ?? "", /m9r-hook(?:\.exe)?$/i);
    assert.equal(m9r?.environment?.M9R_PROVIDER, "opencode");
  }
  assert.equal(existsSync(s.p.opencodePlugin), true);
  const manifest = JSON.parse(readFileSync(s.p.manifest, "utf8")) as { entries: Array<{ path: string; kind: string }> };
  assert.equal(manifest.entries.filter((entry) => entry.kind === "opencode-json").map((entry) => entry.path).sort().join("|"), [modernPath, legacyPath].sort().join("|"));

  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(readFileSync(modernPath, "utf8"), modernBefore);
  assert.equal(readFileSync(legacyPath, "utf8"), legacyBefore);
  assert.equal(existsSync(s.p.opencodePlugin), false);
  s.done();
});

test("native setup refreshes a stale OpenCode plugin that is owned by web setup", async () => {
  const s = sandbox();
  const p = s.p as typeof s.p & { opencodeConfig: string; opencodePlugin: string; webSetupManifest: string };
  const opencodeDirectory = join(s.home, ".config", "opencode");
  mkdirSync(join(opencodeDirectory, "plugins"), { recursive: true });
  mkdirSync(s.p.m9r, { recursive: true });
  writeFileSync(p.opencodeConfig, JSON.stringify({ mcp: {} }, null, 2) + "\n", "utf8");

  const oldPlugin = "old web-setup plugin";
  writeFileSync(p.opencodePlugin, oldPlugin, "utf8");
  writeFileSync(p.webSetupManifest, JSON.stringify({
    version: 1,
    openCodeIdentityPluginPath: p.opencodePlugin,
    openCodeIdentityPluginHash: createHash("sha256").update(oldPlugin).digest("hex"),
    extensionPath: join(s.home, "extension"),
    brokerConfigHash: "preserve-me",
  }, null, 2) + "\n", "utf8");

  const engine = join(s.home, "m9r-engine.exe");
  const shim = join(s.home, "m9r-hook.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(shim, "stand-in stable launcher", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  s.io.env.M9R_OPENCODE_VERSION = "1.19.0";

  assert.equal(await s.run("setup", ["--agents", "opencode", "--yes"]), 0);
  const refreshed = readFileSync(p.opencodePlugin, "utf8");
  assert.notEqual(refreshed, oldPlugin);
  assert.match(refreshed, /OpenCodeExecutionFailed/);
  const webManifest = JSON.parse(readFileSync(p.webSetupManifest, "utf8")) as { openCodeIdentityPluginHash: string; brokerConfigHash: string };
  assert.equal(webManifest.openCodeIdentityPluginHash, createHash("sha256").update(refreshed).digest("hex"));
  assert.equal(webManifest.brokerConfigHash, "preserve-me");
  s.done();
});

test("native OpenCode setup repairs a stale persisted model from the cached catalog and keeps a rollback", async () => {
  const s = sandbox();
  const p = s.p as typeof s.p & { opencodeConfig: string; opencodePlugin: string };
  const opencodeDirectory = join(s.home, ".config", "opencode");
  mkdirSync(opencodeDirectory, { recursive: true });
  writeFileSync(p.opencodeConfig, JSON.stringify({ mcp: {} }, null, 2) + "\n", "utf8");

  const modelStatePath = join(s.home, ".local", "state", "opencode", "model.json");
  const modelCatalogPath = join(s.home, ".cache", "opencode", "models.json");
  mkdirSync(join(s.home, ".local", "state", "opencode"), { recursive: true });
  mkdirSync(join(s.home, ".cache", "opencode"), { recursive: true });
  const originalState = JSON.stringify({
    recent: [
      { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      { providerID: "openai", modelID: "gpt-5.3-codex" },
    ],
    favorite: [],
    variant: {
      "opencode/muse-spark-1.3-contributor-free": "default",
      "openai/gpt-5.3-codex": "default",
    },
    untouched: "keep-me",
  }, null, 2) + "\n";
  writeFileSync(modelStatePath, originalState, "utf8");
  writeFileSync(modelCatalogPath, JSON.stringify({ providers: [{ id: "opencode", models: [{ id: "beam-free" }, { id: "muse-spark-1.3-contributor-free", status: "deprecated" }] }] }), "utf8");

  const engine = join(s.home, "m9r-engine.exe");
  const shim = join(s.home, "m9r-hook.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(shim, "stand-in stable launcher", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  s.io.env.M9R_OPENCODE_VERSION = "1.19.0";

  assert.equal(await s.run("setup", ["--agents", "opencode", "--yes"]), 0);
  const repaired = JSON.parse(readFileSync(modelStatePath, "utf8")) as { recent: Array<{ providerID: string; modelID: string }>; variant: Record<string, string>; untouched: string };
  assert.equal(repaired.recent[0]?.modelID, "beam-free");
  assert.equal(repaired.recent.some((entry) => entry.modelID === "muse-spark-1.3-contributor-free"), false);
  assert.equal(repaired.variant["opencode/muse-spark-1.3-contributor-free"], undefined);
  assert.equal(repaired.variant["openai/gpt-5.3-codex"], "default");
  assert.equal(repaired.untouched, "keep-me");
  const backups = readdirSync(join(s.home, ".local", "state", "opencode")).filter((name) => name.startsWith("model.json.m9r-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(s.home, ".local", "state", "opencode", backups[0]!), "utf8"), originalState);
  s.done();
});

test("without the engine (JS-only runtime), setup does not register the MCP server -- no node_modules ship with the copied runtime yet", async () => {
  const s = sandbox();
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.equal(existsSync(s.p.claudeMcp), false);
  s.done();
});

test("starting with Windows is optional: only with --autostart (or a yes to its own question), and uninstall turns it off", async () => {
  if (process.platform !== "win32") return;
  const s = sandbox();
  const engine = join(s.home, "m9r-engine.exe");
  writeFileSync(engine, "stand-in engine", "utf8");
  writeFileSync(join(s.home, "m9r-hook.exe"), "stand-in native hook", "utf8");
  delete s.io.env.M9R_HOOK_ENTRY;
  s.io.env.M9R_ENGINE = engine;
  s.io.env.M9R_NO_DAEMON = "1";
  autostartCalls.length = 0; brokerAutostartCalls.length = 0; autostartOn = false;
  assert.equal(await s.run("setup", ["--yes"]), 0);
  assert.deepEqual(autostartCalls, [], "--yes alone never turns it on");
  assert.deepEqual(brokerAutostartCalls, [], "--yes alone never installs the owner broker login task");
  assert.equal(await s.run("setup", ["--yes", "--autostart"]), 0);
  assert.equal(autostartCalls.length, 1);
  assert.deepEqual(brokerAutostartCalls, ["install"], "--autostart installs the owner broker login task");
  assert.match(autostartCalls[0], /^enable ".*m9r-engine\.exe" feed --watch --serve-hooks$/);
  assert.equal(JSON.parse(readFileSync(s.p.manifest, "utf8")).autostart, true);
  assert.equal(await s.run("uninstall", ["--yes"]), 0);
  assert.equal(autostartCalls.at(-1), "disable");
  assert.equal(brokerAutostartCalls.at(-1), "remove");
  s.done();
});

test("Windows setup installs the pill, broker, and Driver runtime together and starts the pill", async () => {
  if (process.platform !== "win32") return;
  const s = sandbox();
  try {
    for (const name of ["m9r-engine.exe", "m9r-hook.exe", "m9r-overlay.exe", "m9r-web-broker.exe"]) writeFileSync(join(s.home, name), name);
    const driverDir = join(s.home, "cua-driver-runtime", "node_modules", "driver");
    mkdirSync(driverDir, { recursive: true });
    writeFileSync(join(driverDir, "driver.node"), "driver fixture");
    delete s.io.env.M9R_HOOK_ENTRY;
    s.io.env.M9R_ENGINE = join(s.home, "m9r-engine.exe");
    s.io.env.M9R_NO_DAEMON = "1";
    autostartCalls.length = 0;
    assert.equal(await s.run("setup", ["--yes", "--autostart"]), 0);
    assert.match(autostartCalls.at(-1)!, /m9r-overlay\.exe/);
    assert.equal(readFileSync(join(s.p.m9r, "bin", "m9r-web-broker.exe"), "utf8"), "m9r-web-broker.exe");
    assert.equal(readFileSync(join(s.p.m9r, "bin", "cua-driver-runtime", "node_modules", "driver", "driver.node"), "utf8"), "driver fixture");
    const brokerPath = join(s.p.m9r, "bin", "m9r-web-broker.exe");
    writeFileSync(join(s.p.m9r, "web-broker-install.json"), JSON.stringify({ version: 1, path: brokerPath, sha256: "f".repeat(64) }));
    writeFileSync(join(s.home, "m9r-web-broker.exe"), "new broker from a later engine build", "utf8");
    assert.equal(await s.run("setup", ["--yes"]), 0);
    assert.equal(readFileSync(brokerPath, "utf8"), "m9r-web-broker.exe", "native setup leaves the installer-owned broker for its authenticated updater");
    assert.match(s.out.at(-2) ?? s.out.join("\n"), /Already set up|M9R/);
    assert.equal(await s.run("uninstall", ["--yes"]), 0);
    assert.equal(existsSync(brokerPath), true, "engine uninstall leaves the separately managed broker for its owner manifest");
    assert.equal(existsSync(join(s.p.m9r, "bin", "m9r-overlay.exe")), false);
    assert.equal(existsSync(join(s.p.m9r, "bin", "cua-driver-runtime", "node_modules", "driver", "driver.node")), false);
  } finally { s.done(); }
});

test("a watched feed drains on runtime generation change and releases its writer lock", async () => {
  const s = sandbox({ tempRoot: join(process.cwd(), ".test-tmp") });
  try {
    const executable = join(s.home, "m9r-engine.exe");
    const manifest = join(s.home, "m9r-build-info.json");
    writeFileSync(executable, "stand-in engine", "utf8");
    const writeGeneration = (hash: string) => writeFileSync(manifest, JSON.stringify(createRuntimeBuildInfo({ "m9r-engine.exe": hash })));
    writeGeneration("a".repeat(64));
    s.io.executablePath = executable;
    s.io.env.M9R_NO_CODEX_WATCH = "1";

    const running = s.run("feed", ["--watch"]);
    await new Promise((resolve) => setTimeout(resolve, 2_250));
    writeGeneration("b".repeat(64));
    assert.equal(await running, 0);
    assert.match(s.err.join("\n"), /runtime generation changed on disk; draining the feed/i);
    assert.equal(existsSync(join(s.p.m9r, "feed.lock")), false, "the stale watcher must not strand the single-writer lock");
  } finally { s.done(); }
});

test("provider lifecycle starts only in the watched feed that owns the writer lock and stops before release", async () => {
  const s = sandbox({ tempRoot: join(process.cwd(), ".test-tmp") });
  try {
    s.io.env.M9R_NO_CODEX_WATCH = "1";
    let starts = 0;
    let stops = 0;
    s.io.startProviderLifecycle = () => {
      starts += 1;
      setImmediate(() => process.emit("SIGINT"));
      return { stop: async () => { stops += 1; } };
    };

    const running = s.run("feed", ["--watch"]);
    const duplicateCode = await s.run("feed", ["--watch"]);
    assert.equal(duplicateCode, 0);
    assert.match(s.out.join("\n"), /already being written/);
    assert.equal(starts, 1, "the duplicate feed must not start a second provider monitor");
    assert.equal(await running, 0);
    assert.equal(stops, 1, "the provider monitor is stopped as its feed owner drains");
    assert.equal(existsSync(join(s.p.m9r, "feed.lock")), false);
  } finally { s.done(); }
});

test("the native feed exposes deferred delivery through the provider-neutral adapter pump", async () => {
  const s = sandbox();
  try {
    const store = createLocalStore(s.p.m9r);
    const { task } = store.addTask({
      from: "you",
      to: "codex",
      goal: "resume the held owner task",
      origin: "human_typed",
      idempotencyKey: "deferred-pump",
    });
    store.setDelivery(task.id, { state: "deferred", threadId: "codex-session" });
    const sent: string[] = [];
    const pump = createNativeDeliveryPump(s.p.m9r, {
      env: s.io.env,
      homeDir: s.io.homeDir,
      deliveryAdapters: new Map([[
        "codex",
        async (taskId: string) => {
          sent.push(taskId);
          store.setDelivery(taskId, { state: "queued", threadId: "codex-session", queuedAt: new Date().toISOString() });
        },
      ]]),
    });
    await pump.tick();
    assert.deepEqual(sent, [task.id]);
    assert.equal(store.getTask(task.id)?.delivery?.state, "queued");
  } finally { s.done(); }
});

test("owner-created Claude tasks use the native exact-session adapter instead of the web resident worker", async () => {
  const s = sandbox();
  try {
    const store = createLocalStore(s.p.m9r);
    const claude = store.addTask({ from: "you", to: "claude", goal: "Read one visible label.", origin: "human_typed", idempotencyKey: "native-claude" }).task;
    store.setDelivery(claude.id, { state: "deferred" });
    const nativeDelivery: string[] = [];
    const pump = createNativeDeliveryPump(s.p.m9r, {
      env: s.io.env,
      homeDir: s.io.homeDir,
      cwd: s.home,
      err: s.io.err,
      deliveryAdapters: new Map([["claude", async (taskId: string) => { nativeDelivery.push(taskId); return { state: "unavailable", reason: "test adapter" }; }]]),
    });
    await pump.tick();
    assert.deepEqual(nativeDelivery, [claude.id]);
    assert.equal(store.getTask(claude.id)?.delivery?.state, "deferred", "an unavailable native session stays eligible for an honest retry/inbox path");
    assert.match(s.err.join("\n"), /Claude.*test adapter/i, "the owner must get the adapter's actual failure reason");
  } finally { s.done(); }
});

test("OpenCode owner tasks stay deferred for the exact-session plugin poller, not the web resident worker", async () => {
  const s = sandbox();
  try {
    const store = createLocalStore(s.p.m9r);
    const opencode = store.addTask({ from: "you", to: "opencode", goal: "Read the visible label.", origin: "human_typed", idempotencyKey: "plugin-opencode" }).task;
    store.setDelivery(opencode.id, { state: "deferred" });
    const pump = createNativeDeliveryPump(s.p.m9r, {
      env: s.io.env,
      homeDir: s.io.homeDir,
      cwd: s.home,
    });

    await pump.tick();

    assert.equal(store.getTask(opencode.id)?.delivery?.state, "deferred", "the OpenCode plugin owns delivery into its exact live session");
  } finally { s.done(); }
});

test("m9r note saves to the project room's shared memory where agents read it, and refuses empty or oversized notes", async () => {
  const s = sandbox();
  const project = join(s.home, "proj");
  mkdirSync(project, { recursive: true });
  s.io.env.M9R_PROJECT_ROOT = project;
  assert.equal(await s.run("note", ["Staging", "is", "at", "staging.example.com"]), 0);
  const listed = createPageNotesStore(s.p.m9r).list(projectRoomId(project));
  assert.ok(listed.ok && listed.value.some((n) => n.text === "Staging is at staging.example.com" && n.source === "agent"));
  assert.equal(await s.run("note", []), 1);
  assert.equal(await s.run("note", ["x".repeat(2_001)]), 1);
  assert.equal(createPageNotesStore(s.p.m9r).list(projectRoomId(project)).ok, true);
  s.done();
});

test("the project room id ignores which slash style a path uses", () => {
  assert.equal(projectRoomId("C:\\Users\\someone\\proj"), projectRoomId("C:/Users/someone/proj"));
});
