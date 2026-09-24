import assert from "node:assert/strict";
import test from "node:test";
import { apiKeyLaunchBlock, buildVendorLaunchPlan, type VendorLaunchConfig } from "@/lib/native/vendor-launch-core";

const config: VendorLaunchConfig = {
  vendor: "claude", profile: "web-only", cwd: "C:/repo", mcpConfigPath: "C:/tmp/mcp.json", promptFile: "C:/tmp/prompt.txt",
  mcpCommand: "C:/Program Files/node.exe", mcpArgs: ["C:/repo/scripts/m9r-mcp.js"], mcpEnv: { M9R_HOME: "C:/Users/test/.m9r", M9R_WEB_BROKER_PORT: "47821" },
  sessionToken: "test-token-do-not-log",
};

test("Claude web-only launch disables built-in tools and browser, and loads only M9R MCP", () => {
  const plan = buildVendorLaunchPlan(config);
  assert.equal(plan.command, "claude");
  assert.ok(plan.args.includes("--strict-mcp-config"));
  assert.ok(plan.args.includes("--no-chrome"));
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--tools"), plan.args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(JSON.parse(plan.mcpConfigJson ?? "{}"), {
    mcpServers: { m9r: { command: config.mcpCommand, args: config.mcpArgs, env: config.mcpEnv } },
  });
  assert.ok(plan.promptFileContent?.includes(config.sessionToken));
});

test("Claude hands profile enables only the requested local tool set plus M9R", () => {
  const plan = buildVendorLaunchPlan({ ...config, profile: "hands" });
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--tools"), plan.args.indexOf("--tools") + 2), ["--tools", "Bash,Read,Edit,Glob,Grep"]);
  assert.ok(plan.args.includes("mcp__m9r"));
});

test("Codex launch disables web search, overrides MCP servers with M9R, and keeps the token off argv", () => {
  const plan = buildVendorLaunchPlan({ ...config, vendor: "codex" });
  assert.equal(plan.command, "codex");
  assert.ok(plan.args.includes('web_search="disabled"'));
  assert.ok(plan.args.includes("--disable") && plan.args.includes("shell_tool"));
  assert.ok(plan.args.includes("-") );
  assert.ok(plan.args.some((arg) => arg.includes("mcp_servers={m9r=")));
  assert.equal(plan.args.join(" ").includes(config.sessionToken), false);
  assert.ok(plan.stdinPrompt?.includes(config.sessionToken));
});

test("Codex hands profile stays workspace-write and does not re-enable web search", () => {
  const plan = buildVendorLaunchPlan({ ...config, vendor: "codex", profile: "hands" });
  assert.ok(plan.args.includes("workspace-write"));
  assert.ok(plan.args.includes('web_search="disabled"'));
  assert.equal(plan.args.includes("shell_tool"), false);
});

test("launcher blocks either API key unless the user explicitly overrides", () => {
  assert.match(apiKeyLaunchBlock({ OPENAI_API_KEY: "secret" }, false) ?? "", /OPENAI_API_KEY/);
  assert.match(apiKeyLaunchBlock({ ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret" }, false) ?? "", /ANTHROPIC_API_KEY and OPENAI_API_KEY/);
  assert.equal(apiKeyLaunchBlock({ OPENAI_API_KEY: "secret" }, true), null);
  assert.equal(apiKeyLaunchBlock({}, false), null);
});
