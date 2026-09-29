import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildClaudeMcpAddArgs,
  buildClaudeMcpRemoveArgs,
  buildPowerShellInvocation,
  extensionIdFromManifestKey,
  formatCommandPreview,
  mergeCodexWebMcp,
  mergeOpenCodeWebMcp,
  planWebSetup,
  resolveOpenCodeGlobalPaths,
  removeCodexWebMcp,
  removeOpenCodeWebMcp,
  resolveWebMcpRuntime,
  selectWebSetupAgents,
  parseWebSetupList,
  webConfigUninstallMode,
  webExtensionFileAction,
  planManagedWebExtensionRefresh,
  webExtensionAllowlist,
  shouldOpenBrowserSetup,
  WEB_EXTENSION_ID,
  webOpenCodeLayout,
} from "../src/lib/native/web-setup-core.ts";

const command = { command: "C:/Users/Ada/.m9r/bin/m9r-engine.exe", args: ["mcp"], m9rHome: "C:/Users/Ada/.m9r", brokerPort: 47821 };
const detected = [
  { kind: "claude-code" as const, label: "Claude Code", binary: "claude", versionLine: "2.1.10" },
  { kind: "codex" as const, label: "Codex", binary: "codex", versionLine: "0.42.0" },
];

test("web setup selection defaults to detected agents and rejects explicitly requested missing agents", () => {
  assert.deepEqual(selectWebSetupAgents(detected), ["claude-code", "codex"]);
  assert.deepEqual(selectWebSetupAgents(detected, ["codex"]), ["codex"]);
  assert.throws(() => selectWebSetupAgents(detected, ["opencode"]), /OpenCode.*not found/i);
});

test("OpenCode MCP layout is selected from detected major version", () => {
  assert.equal(webOpenCodeLayout("opencode 1.9.2"), "legacy");
  assert.equal(webOpenCodeLayout("2.0.0-beta.3"), "servers");
  assert.equal(webOpenCodeLayout("OpenCode v2.1.0"), "servers");
  assert.equal(webOpenCodeLayout("unknown"), "legacy");
});

test("OpenCode global paths follow XDG or ~/.config and preserve an existing supported config", () => {
  const existing = new Set([
    join("C:/Users/Ada", ".config", "opencode", "opencode.jsonc"),
    join("C:/Users/Ada", "AppData", "Roaming", "opencode", "opencode.json"),
  ]);
  const paths = resolveOpenCodeGlobalPaths({
    home: "C:/Users/Ada",
    appData: "C:/Users/Ada/AppData/Roaming",
    exists: (path) => existing.has(path),
  });
  assert.equal(paths.configPath, join("C:/Users/Ada", ".config", "opencode", "opencode.jsonc"));
  assert.equal(paths.pluginDirectory, join("C:/Users/Ada", ".config", "opencode", "plugins"));

  const xdgPaths = resolveOpenCodeGlobalPaths({
    home: "C:/Users/Ada",
    xdgConfigHome: "D:/Agent Config",
    exists: () => false,
  });
  assert.equal(xdgPaths.configPath, join("D:/Agent Config", "opencode", "opencode.json"));
  assert.equal(xdgPaths.pluginDirectory, join("D:/Agent Config", "opencode", "plugins"));

  const legacyConfig = resolveOpenCodeGlobalPaths({
    home: "C:/Users/Ada",
    appData: "C:/Users/Ada/AppData/Roaming",
    exists: (path) => path === join("C:/Users/Ada", "AppData", "Roaming", "opencode", "opencode.json"),
  });
  assert.equal(legacyConfig.configPath, join("C:/Users/Ada", "AppData", "Roaming", "opencode", "opencode.json"));
  assert.equal(legacyConfig.pluginDirectory, join("C:/Users/Ada", "AppData", "Roaming", "opencode", "plugins"));
});

test("browser setup UI opens only when explicitly requested", () => {
  assert.equal(shouldOpenBrowserSetup(["setup", "--yes"]), false);
  assert.equal(shouldOpenBrowserSetup(["setup", "--open-browser-setup"]), true);
});

test("fixed unpacked extension ID is a valid Chromium extension identifier", () => {
  assert.match(WEB_EXTENSION_ID, /^[a-p]{32}$/);
  const manifest = JSON.parse(readFileSync(new URL("../extensions/browser/manifest.json", import.meta.url), "utf8")) as { key?: string };
  assert.equal(extensionIdFromManifestKey(manifest.key ?? ""), WEB_EXTENSION_ID);
});

test("the broker allow-list includes the development ID and the configured Web Store ID from one canonical helper", () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop";
  assert.deepEqual(webExtensionAllowlist({ storeId }), [WEB_EXTENSION_ID, storeId]);
  assert.deepEqual(webExtensionAllowlist({ developmentId: storeId, storeId }), [storeId], "duplicate IDs are collapsed");
  assert.throws(() => webExtensionAllowlist({ storeId: "not-an-extension-id" }), /M9R_WEB_STORE_EXTENSION_ID/);
  const previous = process.env.M9R_WEB_STORE_EXTENSION_ID;
  try {
    process.env.M9R_WEB_STORE_EXTENSION_ID = storeId;
    assert.deepEqual(webExtensionAllowlist(), [WEB_EXTENSION_ID, storeId]);
  } finally {
    if (previous === undefined) delete process.env.M9R_WEB_STORE_EXTENSION_ID;
    else process.env.M9R_WEB_STORE_EXTENSION_ID = previous;
  }
});

test("Claude user-scope registration uses the native CLI, stdio, M9R_HOME, and an explicit command boundary", () => {
  assert.deepEqual(buildClaudeMcpAddArgs(command), [
    "mcp", "add", "--scope", "user", "--transport", "stdio", "m9r",
    "--env", "M9R_HOME=C:/Users/Ada/.m9r", "--env", "M9R_WEB_BROKER_PORT=47821",
    "--", "C:/Users/Ada/.m9r/bin/m9r-engine.exe", "mcp",
  ]);
  assert.deepEqual(buildClaudeMcpRemoveArgs(), ["mcp", "remove", "m9r", "--scope", "user"]);
});

test("Windows Claude CLI preview and PowerShell invocation preserve spaces and quotes in every argument", () => {
  const args = buildClaudeMcpAddArgs({ ...command, command: "C:/Program Files/nodejs/node.exe", m9rHome: "C:/Users/O'Brien Files/.m9r" });
  const script = buildPowerShellInvocation("C:/Users/O'Brien Files/claude.cmd", args);
  assert.match(script, /'C:\/Users\/O''Brien Files\/claude\.cmd'/);
  assert.match(script, /'M9R_HOME=C:\/Users\/O''Brien Files\/\.m9r'/);
  assert.match(script, /'C:\/Program Files\/nodejs\/node\.exe'/);
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.match(formatCommandPreview("claude", args), /"M9R_HOME=C:\/Users\/O'Brien Files\/\.m9r"/);
  assert.match(formatCommandPreview("claude", args), /"C:\/Program Files\/nodejs\/node\.exe"/);
});

test("MCP runtime selection prefers the stable installed engine over an installer temp executable", () => {
  assert.deepEqual(resolveWebMcpRuntime({
    nodeCommand: "node.exe", currentEngine: "C:/Temp/m9r-engine.exe", installedEngine: "C:/Users/Ada/.m9r/bin/m9r-engine.exe",
  }), { command: "C:/Users/Ada/.m9r/bin/m9r-engine.exe", args: ["mcp"] });
  assert.deepEqual(resolveWebMcpRuntime({ nodeCommand: "node.exe", compiledMcp: "C:/cli/dist/m9r-mcp.js" }), {
    command: "node.exe", args: ["C:/cli/dist/m9r-mcp.js"],
  });
  assert.deepEqual(resolveWebMcpRuntime({ nodeCommand: "node.exe", sourceMcp: "C:/repo/scripts/m9r-mcp.ts", sourceNodeArgs: ["--import", "register.mjs"] }), {
    command: "node.exe", args: ["--import", "register.mjs", "C:/repo/scripts/m9r-mcp.ts"],
  });
});

test("Codex web MCP merge is idempotent, updates a pre-existing m9r table, and preserves other tables", () => {
  const original = "# keep me\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n\n[mcp_servers.m9r]\ncommand = \"old\"\nargs = []\n\n[profiles.work]\nmodel = \"codex\"\n";
  const once = mergeCodexWebMcp(original, command);
  assert.equal(mergeCodexWebMcp(once, command), once);
  assert.equal((once.match(/^\[mcp_servers\.m9r\]$/gm) ?? []).length, 1);
  assert.equal((once.match(/^\[mcp_servers\.m9r\.env\]$/gm) ?? []).length, 1);
  assert.match(once, /M9R_HOME = "C:\/Users\/Ada\/\.m9r"/);
  assert.match(once, /\[mcp_servers\.github\][\s\S]*command = "gh-mcp"/);
  assert.match(once, /\[profiles\.work\][\s\S]*model = "codex"/);
  const uninstalled = removeCodexWebMcp(once);
  assert.doesNotMatch(uninstalled, /m9r-web-managed|\[mcp_servers\.m9r(?:\.env)?\]/);
  assert.match(uninstalled, /\[mcp_servers\.github\]/);
  assert.match(uninstalled, /\[profiles\.work\]/);
});

test("OpenCode JSONC merge uses legacy or v2 layout without rewriting unrelated comments", () => {
  const original = `{
  // user comment stays
  "mcp": {
    "github": { "type": "local", "command": ["gh-mcp"] },
  },
}`;
  const legacy = mergeOpenCodeWebMcp(original, "legacy", command);
  const legacyAgain = mergeOpenCodeWebMcp(legacy, "legacy", command);
  assert.equal(legacyAgain, legacy);
  assert.match(legacy, /\/\/ user comment stays/);
  assert.match(legacy, /"mcp"\s*:\s*\{[\s\S]*"github"[\s\S]*"m9r"/);
  assert.equal(JSON.parse(legacy.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1")).mcp.m9r.environment.M9R_HOME, command.m9rHome);

  const modern = mergeOpenCodeWebMcp(original, "servers", command);
  const parsed = JSON.parse(modern.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
  assert.deepEqual(parsed.mcp.servers.m9r.command, [command.command, "mcp"]);
  assert.equal(parsed.mcp.servers.m9r.environment.M9R_HOME, command.m9rHome);
  const uninstalled = removeOpenCodeWebMcp(modern, "servers");
  assert.doesNotMatch(uninstalled, /"m9r"/);
  assert.match(uninstalled, /\/\/ user comment stays/);
  assert.match(uninstalled, /"github"/);
});

test("invalid OpenCode JSONC is refused rather than replaced or truncated", () => {
  assert.throws(() => mergeOpenCodeWebMcp("{ broken", "servers", command), /invalid|parse/i);
});

test("web setup planner maps only selected detections to absolute per-agent config writes and broker allow-list", () => {
  const plan = planWebSetup({
    detected,
    selectedAgents: ["codex"],
    engineCommand: command.command,
    mcpArgs: command.args,
    m9rHome: command.m9rHome,
    configPaths: { "claude-code": "C:/Users/Ada/.claude.json", codex: "C:/Users/Ada/.codex/config.toml", opencode: "C:/Users/Ada/AppData/Roaming/opencode/opencode.json" },
    extensionPath: "C:/Users/Ada/AppData/Local/M9R/extension",
    browsers: ["chrome", "edge"],
    extensionId: "mahhaigfogjneccbmbpbedlnkhgdcmhb",
  });
  assert.deepEqual(plan.agentFiles.map((file) => file.agent), ["codex"]);
  assert.equal(plan.agentFiles[0]?.path, "C:/Users/Ada/.codex/config.toml");
  assert.deepEqual(plan.browsers, ["chrome", "edge"]);
  assert.deepEqual(plan.allowedExtensionIds, ["mahhaigfogjneccbmbpbedlnkhgdcmhb"]);
  assert.equal(plan.m9rHome, command.m9rHome);
  assert.throws(() => planWebSetup({
    detected, selectedAgents: ["codex"], engineCommand: "node", mcpArgs: ["mcp"], m9rHome: command.m9rHome,
    configPaths: { codex: "C:/Users/Ada/.codex/config.toml" }, extensionPath: "C:/Users/Ada/AppData/Local/M9R/extension",
    browsers: [], extensionId: WEB_EXTENSION_ID,
  }), /absolute/i);
});

test("web setup list parsing validates explicit agents and browser selections", () => {
  assert.deepEqual(parseWebSetupList("Claude-Code,codex,claude-code", ["claude-code", "codex", "opencode"], "agent"), ["claude-code", "codex"]);
  assert.throws(() => parseWebSetupList("all", ["claude-code", "codex", "opencode"], "agent"), /Unknown agent/);
});

test("uninstall restores only unchanged managed config and preserves later user edits", () => {
  assert.equal(webConfigUninstallMode({ existedBefore: true, currentHash: "after", installedHash: "after" }), "restore-backup");
  assert.equal(webConfigUninstallMode({ existedBefore: false, currentHash: "after", installedHash: "after" }), "delete-created-file");
  assert.equal(webConfigUninstallMode({ existedBefore: true, currentHash: "user-edited", installedHash: "after" }), "remove-managed-entry");
  assert.equal(webConfigUninstallMode({ existedBefore: true, currentHash: null, installedHash: "after" }), "unchanged");
});

test("extension refresh updates only files still matching the prior install hash", () => {
  assert.equal(webExtensionFileAction({ currentHash: null, installedHash: null, desiredHash: "new" }), "write");
  assert.equal(webExtensionFileAction({ currentHash: "old", installedHash: "old", desiredHash: "new" }), "write");
  assert.equal(webExtensionFileAction({ currentHash: "new", installedHash: "old", desiredHash: "new" }), "preserve");
  assert.equal(webExtensionFileAction({ currentHash: "old", installedHash: null, desiredHash: "new" }), "preserve");
  assert.equal(webExtensionFileAction({ currentHash: "old", installedHash: "old", desiredHash: "old" }), "unchanged");
  assert.equal(webExtensionFileAction({ currentHash: "old", installedHash: "old" }), "delete");
  assert.equal(webExtensionFileAction({ currentHash: "user", installedHash: "old" }), "preserve");
});

test("extension-only refresh updates owned files and leaves user edits and untracked files alone", () => {
  const plan = planManagedWebExtensionRefresh({
    sourceFiles: [
      { relativePath: "src/content.js", desiredHash: "new-content" },
      { relativePath: "src/presence-overlay.js", desiredHash: "new-overlay" },
      { relativePath: "src/untracked.js", desiredHash: "source-untracked" },
      { relativePath: "src/missing.js", desiredHash: "new-file" },
    ],
    installedFiles: [
      { relativePath: "src/content.js", installedHash: "old-content" },
      { relativePath: "src/presence-overlay.js", installedHash: "old-overlay" },
    ],
    currentHashes: new Map([
      ["src/content.js", "old-content"],
      ["src/presence-overlay.js", "locally-edited"],
      ["src/untracked.js", "untracked-user-file"],
    ]),
  });

  assert.deepEqual(plan.map(({ relativePath, action }) => [relativePath, action]), [
    ["src/content.js", "write"],
    ["src/presence-overlay.js", "preserve"],
    ["src/untracked.js", "preserve"],
    ["src/missing.js", "write"],
  ]);
});

test("extension-only refresh rejects duplicate and path-escaping files", () => {
  const empty = { installedFiles: [], currentHashes: new Map<string, string | null>() };
  assert.throws(() => planManagedWebExtensionRefresh({ ...empty, sourceFiles: [
    { relativePath: "src/../outside.js", desiredHash: "hash" },
  ] }), /Unsafe managed extension relative path/);
  assert.throws(() => planManagedWebExtensionRefresh({ ...empty, sourceFiles: [
    { relativePath: "src/content.js", desiredHash: "one" },
    { relativePath: "src/content.js", desiredHash: "two" },
  ] }), /Duplicate extension source path/);
});
