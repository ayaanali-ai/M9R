export type M9rLaunchVendor = "claude" | "codex";
export type M9rLaunchProfile = "web-only" | "hands";

export interface VendorLaunchConfig {
  vendor: M9rLaunchVendor;
  profile: M9rLaunchProfile;
  cwd: string;
  mcpConfigPath: string;
  promptFile: string;
  mcpCommand: string;
  mcpArgs: string[];
  mcpEnv: Record<string, string>;
  sessionToken: string;
}

export interface VendorLaunchPlan {
  command: string;
  args: string[];
  mcpConfigJson?: string;
  promptFileContent?: string;
  stdinPrompt?: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexMcpOverride(config: VendorLaunchConfig): string {
  const args = config.mcpArgs.map(tomlString).join(",");
  const env = Object.entries(config.mcpEnv).map(([key, value]) => `${key}=${tomlString(value)}`).join(",");
  return `mcp_servers={m9r={command=${tomlString(config.mcpCommand)},args=[${args}],env={${env}}}}`;
}

function launchPrompt(token: string): string {
  return [
    "M9R is your only browser/web interaction layer in this session. Use its M9R MCP tools for web work.",
    `Your M9R session token is ${token}. Pass it only to M9R tools that request it; do not print or share it.`,
    "Do not use browser integrations or web search. Report what each M9R action actually observed.",
  ].join("\n");
}

export function apiKeyLaunchBlock(env: Record<string, string | undefined>, allowApiKey: boolean): string | null {
  if (allowApiKey) return null;
  const present = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((name) => env[name] !== undefined && env[name] !== "");
  return present.length ? `Refusing to launch because ${present.join(" and ")} ${present.length === 1 ? "is" : "are"} set. Pass --allow-api-key only if you intend to use API-key billing.` : null;
}

export function buildVendorLaunchPlan(config: VendorLaunchConfig): VendorLaunchPlan {
  const prompt = launchPrompt(config.sessionToken);
  if (config.vendor === "claude") {
    const tools = config.profile === "web-only" ? "" : "Bash,Read,Edit,Glob,Grep";
    const args = [
      "--strict-mcp-config", "--mcp-config", config.mcpConfigPath,
      "--setting-sources", "project",
      "--no-chrome",
      "--tools", tools,
      "--allowedTools", "mcp__m9r",
      "--append-system-prompt-file", config.promptFile,
    ];
    return {
      command: "claude",
      args,
      mcpConfigJson: JSON.stringify({ mcpServers: { m9r: { command: config.mcpCommand, args: config.mcpArgs, env: config.mcpEnv } } }, null, 2),
      promptFileContent: prompt,
    };
  }

  const args = [
    "exec", "--cd", config.cwd,
    "--ignore-user-config", "--ignore-rules",
    "--sandbox", config.profile === "web-only" ? "read-only" : "workspace-write",
    "-c", 'web_search="disabled"',
    "-c", buildCodexMcpOverride(config),
  ];
  if (config.profile === "web-only") args.push("--disable", "shell_tool");
  args.push("-");
  return {
    command: "codex",
    args,
    stdinPrompt: prompt,
  };
}
