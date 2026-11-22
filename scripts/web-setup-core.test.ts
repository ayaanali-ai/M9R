import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  buildClaudeMcpRemoveArgs,
  buildPowerShellInvocation,
  removeCodexWebMcp,
  removeOpenCodeWebMcp,
  resolveOpenCodeGlobalPaths,
  webConfigUninstallMode,
  webOpenCodeLayout,
} from "../src/lib/native/web-setup-core.ts";

test("OpenCode layout and config paths still resolve for safe legacy cleanup", () => {
  assert.equal(webOpenCodeLayout("opencode 1.9.2"), "legacy");
  assert.equal(webOpenCodeLayout("OpenCode v2.1.0"), "servers");

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
});

test("legacy config uninstall decisions preserve user edits and untouched files", () => {
  assert.equal(webConfigUninstallMode({ existedBefore: true, currentHash: "after", installedHash: "after" }), "restore-backup");
  assert.equal(webConfigUninstallMode({ existedBefore: false, currentHash: "after", installedHash: "after" }), "delete-created-file");
  assert.equal(webConfigUninstallMode({ existedBefore: true, currentHash: "user-edited", installedHash: "after" }), "remove-managed-entry");
  assert.equal(webConfigUninstallMode({ existedBefore: true, currentHash: null, installedHash: "after" }), "unchanged");
  assert.deepEqual(buildClaudeMcpRemoveArgs(), ["mcp", "remove", "m9r", "--scope", "user"]);
  assert.match(buildPowerShellInvocation("C:/Users/O'Brien Files/claude.cmd", ["mcp", "remove", "m9r"]), /O''Brien Files/);
});

test("Codex legacy cleanup removes only M9R's managed MCP sections", () => {
  const original = "# keep me\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n\n[mcp_servers.m9r]\ncommand = \"old\"\nargs = []\n\n[mcp_servers.m9r.env]\nM9R_HOME = \"old\"\n\n[profiles.work]\nmodel = \"codex\"\n";
  const cleaned = removeCodexWebMcp(original);
  assert.doesNotMatch(cleaned, /\[mcp_servers\.m9r(?:\.env)?\]/);
  assert.match(cleaned, /\[mcp_servers\.github\][\s\S]*command = \"gh-mcp\"/);
  assert.match(cleaned, /\[profiles\.work\][\s\S]*model = \"codex\"/);
  assert.equal(removeCodexWebMcp(cleaned), cleaned);
});

test("OpenCode legacy cleanup removes only M9R MCP and identity-plugin entries", () => {
  const original = `{
  // keep the user's unrelated settings
  "plugin": ["./plugins/custom.js", "./plugins/m9r-identity.js"],
  "mcp": {
    "github": { "type": "local", "command": ["gh-mcp"] },
    "servers": { "m9r": { "type": "local", "command": ["old-m9r"] } },
    "m9r": { "type": "local", "command": ["user-owned-mcp"] },
  },
}`;
  const cleaned = removeOpenCodeWebMcp(original, "servers", true);
  assert.match(cleaned, /\/\/ keep the user's unrelated settings/);
  assert.match(cleaned, /custom\.js/);
  assert.doesNotMatch(cleaned, /m9r-identity\.js|old-m9r/);
  assert.match(cleaned, /user-owned-mcp/, "the other config layout may be user-owned and is preserved");
  assert.match(cleaned, /gh-mcp/);
  assert.deepEqual(removeOpenCodeWebMcp(cleaned, "servers", true), cleaned);
});

test("invalid OpenCode JSONC is left untouched by legacy cleanup", () => {
  assert.throws(() => removeOpenCodeWebMcp("{ broken", "servers", true), /invalid|parse/i);
});
