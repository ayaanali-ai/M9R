import { DETECTABLE_AGENT_KINDS, type DetectedAgent, type DetectableAgentKind } from "../agent-detection-core";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export type WebOpenCodeLayout = "legacy" | "servers";
export type WebSetupBrowser = "chrome" | "edge";
export type WebConfigUninstallMode = "restore-backup" | "remove-managed-entry" | "delete-created-file" | "unchanged";
export type WebExtensionFileAction = "write" | "preserve" | "unchanged" | "delete";

/** Stable unpacked-development identity. The Web Store assigns its own production ID. */
export const WEB_EXTENSION_ID = "mahhaigfogjneccbmbpbedlnkhgdcmhb";
/** Set after the Chrome Web Store assigns the production extension ID. */
export const WEB_STORE_EXTENSION_ID_ENV = "M9R_WEB_STORE_EXTENSION_ID";

/** Prefer XDG paths and retain an existing APPDATA config, with plugins beside the selected config. */
export function resolveOpenCodeGlobalPaths(input: {
  home: string;
  xdgConfigHome?: string;
  appData?: string;
  exists?: (path: string) => boolean;
}): { configPath: string; pluginDirectory: string } {
  const configHome = input.xdgConfigHome?.trim() || join(input.home, ".config");
  const configDirectory = join(configHome, "opencode");
  const configDirectories = [
    configDirectory,
    ...(input.appData?.trim() ? [join(input.appData.trim(), "opencode")] : []),
  ];
  const supportedConfig = configDirectories
    .flatMap((directory) => ["opencode.jsonc", "opencode.json"].map((name) => join(directory, name)))
    .find((path) => input.exists?.(path) ?? false);
  const configPath = supportedConfig ?? join(configDirectory, "opencode.json");
  return {
    configPath,
    pluginDirectory: join(dirname(configPath), "plugins"),
  };
}

/** Browser-internal setup pages are opened only when the user supplies the explicit opt-in. */
export function shouldOpenBrowserSetup(args: readonly string[]): boolean {
  return args.includes("--open-browser-setup");
}

export const OPENCODE_IDENTITY_PLUGIN_FILENAME = "m9r-identity.js";

export interface OpenCodeHookInvocation {
  command: string;
  args: readonly string[];
}

/** Prefer the standalone engine so the plugin invokes the same native SessionStart flow as installed hooks. */
export function resolveOpenCodeHookInvocation(input: {
  nodeCommand: string;
  engineExecutable?: string;
  compiledHookPath?: string;
  sourceHookPath?: string;
  sourceNodeArgs?: readonly string[];
}): OpenCodeHookInvocation {
  if (input.engineExecutable?.trim()) {
    return {
      command: input.engineExecutable,
      args: ["m9r-hook", "SessionStart", "opencode"],
    };
  }
  if (input.compiledHookPath) {
    return {
      command: input.nodeCommand,
      args: [input.compiledHookPath, "SessionStart", "opencode"],
    };
  }
  if (input.sourceHookPath) {
    return {
      command: input.nodeCommand,
      args: [...(input.sourceNodeArgs ?? []), input.sourceHookPath, "SessionStart", "opencode"],
    };
  }
  throw new Error("The M9R OpenCode SessionStart hook entry point was not found beside this CLI or in the local M9R installation.");
}

/** Accept only the additionalContext field returned for the SessionStart hook. */
export function extractOpenCodeAdditionalContext(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const hookOutput = (parsed as Record<string, unknown>).hookSpecificOutput;
    if (!hookOutput || typeof hookOutput !== "object" || Array.isArray(hookOutput)) return null;
    const record = hookOutput as Record<string, unknown>;
    return record.hookEventName === "SessionStart" && typeof record.additionalContext === "string" && record.additionalContext.length > 0
      ? record.additionalContext
      : null;
  } catch {
    return null;
  }
}

export type OpenCodeIdentityPluginInstallAction = "install" | "upgrade" | "unchanged" | "preserve" | "path-changed";

export function planOpenCodeIdentityPluginInstall(input: {
  targetPath: string;
  currentHash: string | null;
  desiredHash: string;
  ownedPath?: string;
  ownedHash?: string;
}): OpenCodeIdentityPluginInstallAction {
  if (input.ownedPath && input.ownedPath !== input.targetPath) return "path-changed";
  if (input.currentHash === null) return "install";
  if (!input.ownedPath || !input.ownedHash || input.currentHash !== input.ownedHash) return "preserve";
  return input.currentHash === input.desiredHash ? "unchanged" : "upgrade";
}

export type OpenCodeIdentityPluginRemovalAction = "remove" | "already-absent" | "preserve" | "not-owned" | "path-changed";

export function planOpenCodeIdentityPluginRemoval(input: {
  targetPath: string;
  currentHash: string | null;
  ownedPath?: string;
  ownedHash?: string;
}): OpenCodeIdentityPluginRemovalAction {
  if (!input.ownedPath || !input.ownedHash) return "not-owned";
  if (input.ownedPath !== input.targetPath) return "path-changed";
  if (input.currentHash === null) return "already-absent";
  return input.currentHash === input.ownedHash ? "remove" : "preserve";
}

/** Build a self-contained OpenCode plugin; parse the hook response before injecting its one trusted field. */
export function buildOpenCodeIdentityPluginSource(invocation: OpenCodeHookInvocation): string {
  const parser = extractOpenCodeAdditionalContext.toString().replace(/^function /, "function ");
  return `import { spawn } from "node:child_process";

const M9R_HOOK_COMMAND = ${JSON.stringify(invocation.command)};
const M9R_HOOK_ARGS = ${JSON.stringify(invocation.args)};
const M9R_HOOK_TIMEOUT_MS = 5000;
const M9R_MAX_CACHED_SESSIONS = 256;
const M9R_SESSION_BOOTSTRAPS = new Map();

${parser}

function runM9rSessionStart(sessionID, cwd) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let oversized = false;
    const child = spawn(M9R_HOOK_COMMAND, M9R_HOOK_ARGS, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, M9R_HOOK_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 262144) {
        oversized = true;
        child.kill();
        finish(null);
        return;
      }
      stdout += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(!oversized && code === 0 ? stdout : null));
    child.stdin.once("error", () => finish(null));
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd }));
  });
}

function bootstrapSession(sessionID, cwd) {
  const cached = M9R_SESSION_BOOTSTRAPS.get(sessionID);
  if (cached) {
    M9R_SESSION_BOOTSTRAPS.delete(sessionID);
    M9R_SESSION_BOOTSTRAPS.set(sessionID, cached);
    return cached.promise;
  }

  if (M9R_SESSION_BOOTSTRAPS.size >= M9R_MAX_CACHED_SESSIONS) {
    const oldestSettled = [...M9R_SESSION_BOOTSTRAPS.entries()].find(([, entry]) => entry.settled);
    if (!oldestSettled) return Promise.resolve(null);
    M9R_SESSION_BOOTSTRAPS.delete(oldestSettled[0]);
  }

  const entry = { promise: null, settled: false };
  const promise = Promise.resolve()
    .then(() => runM9rSessionStart(sessionID, cwd))
    .then((raw) => typeof raw === "string" ? extractOpenCodeAdditionalContext(raw) : null)
    .catch(() => null)
    .then((context) => {
      entry.settled = true;
      if (context === null && M9R_SESSION_BOOTSTRAPS.get(sessionID) === entry) {
        M9R_SESSION_BOOTSTRAPS.delete(sessionID);
      }
      return context;
    });
  entry.promise = promise;
  M9R_SESSION_BOOTSTRAPS.set(sessionID, entry);
  return promise;
}

export const M9rIdentity = async ({ directory } = {}) => ({
  "experimental.chat.system.transform": async (input, output) => {
    const sessionID = input?.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) return;
    const cwd = typeof directory === "string" && directory.length > 0 ? directory : process.cwd();
    const context = await bootstrapSession(sessionID, cwd);
    if (context !== null && Array.isArray(output?.system)) output.system.push(context);
  },
});
`;
}

/** One canonical allow-list source for setup, bundled broker, and the CLI broker. */
export function webExtensionAllowlist(input: {
  developmentId?: string;
  storeId?: string;
} = {}): string[] {
  const developmentId = input.developmentId ?? WEB_EXTENSION_ID;
  const storeId = input.storeId ?? process.env[WEB_STORE_EXTENSION_ID_ENV]?.trim();
  if (!/^[a-p]{32}$/.test(developmentId)) throw new Error("The M9R development extension ID is invalid.");
  if (storeId && !/^[a-p]{32}$/.test(storeId)) throw new Error(`${WEB_STORE_EXTENSION_ID_ENV} must be a valid 32-character Chromium extension ID.`);
  return [...new Set([developmentId, ...(storeId ? [storeId] : [])])];
}

export function extensionIdFromManifestKey(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
}

export interface WebMcpCommand {
  command: string;
  args: readonly string[];
  m9rHome: string;
  brokerPort?: number;
}

export function resolveWebMcpRuntime(input: {
  nodeCommand: string;
  installedEngine?: string;
  currentEngine?: string;
  compiledMcp?: string;
  sourceMcp?: string;
  sourceNodeArgs?: readonly string[];
}): Pick<WebMcpCommand, "command" | "args"> {
  if (input.installedEngine) return { command: input.installedEngine, args: ["mcp"] };
  if (input.currentEngine) return { command: input.currentEngine, args: ["mcp"] };
  if (input.compiledMcp) return { command: input.nodeCommand, args: [input.compiledMcp] };
  if (input.sourceMcp) return { command: input.nodeCommand, args: [...(input.sourceNodeArgs ?? []), input.sourceMcp] };
  throw new Error("M9R's MCP entry point was not found beside this CLI or in the local M9R installation.");
}

export interface WebSetupInput {
  detected: readonly DetectedAgent[];
  selectedAgents: readonly string[];
  engineCommand: string;
  mcpArgs: readonly string[];
  m9rHome: string;
  configPaths: Partial<Record<DetectableAgentKind, string>>;
  extensionPath: string;
  browsers: readonly WebSetupBrowser[];
  extensionId: string;
}

export interface WebSetupPlan {
  selectedAgents: DetectableAgentKind[];
  agentFiles: Array<{ agent: DetectableAgentKind; path: string; layout?: WebOpenCodeLayout }>;
  extensionPath: string;
  browsers: WebSetupBrowser[];
  allowedExtensionIds: string[];
  m9rHome: string;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

const AGENT_LABELS: Record<DetectableAgentKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function selectWebSetupAgents(detected: readonly DetectedAgent[], requested?: readonly string[]): DetectableAgentKind[] {
  const available = new Set(detected.map((agent) => agent.kind));
  const selected = requested === undefined ? DETECTABLE_AGENT_KINDS.filter((kind) => available.has(kind)) : [...new Set(requested)];
  for (const value of selected) {
    if (!(DETECTABLE_AGENT_KINDS as readonly string[]).includes(value)) throw new Error(`Unknown agent "${value}". Choose claude-code, codex, or opencode.`);
    const kind = value as DetectableAgentKind;
    if (!available.has(kind)) throw new Error(`${AGENT_LABELS[kind]} was requested but not found on PATH.`);
  }
  if (selected.length === 0) throw new Error("No installed agents selected. Install Claude Code, Codex, or OpenCode, then run setup again.");
  return selected as DetectableAgentKind[];
}

/** OpenCode 2.x moved local servers from `mcp.<name>` into `mcp.servers.<name>`. */
export function webOpenCodeLayout(versionLine: string | undefined): WebOpenCodeLayout {
  const match = versionLine?.match(/(?:^|\s)v?(\d+)\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/i);
  return match && Number(match[1]) >= 2 ? "servers" : "legacy";
}

export function buildClaudeMcpAddArgs(command: WebMcpCommand): string[] {
  return [
    "mcp", "add", "--scope", "user", "--transport", "stdio", "m9r",
    "--env", `M9R_HOME=${command.m9rHome}`,
    "--env", `M9R_WEB_BROKER_PORT=${command.brokerPort ?? 47821}`,
    "--", command.command, ...command.args,
  ];
}

export function buildClaudeMcpRemoveArgs(): string[] {
  return ["mcp", "remove", "m9r", "--scope", "user"];
}

/** PowerShell single-quoted literals preserve Windows paths and shell metacharacters as ordinary argument text. */
export function buildPowerShellInvocation(binary: string, args: readonly string[]): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const invocation = `& ${[binary, ...args].map(literal).join(" ")}`;
  return `$ErrorActionPreference = 'Stop'; ${invocation}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
}

/** Human-readable equivalent of a native CLI argv vector for the setup preview. */
export function formatCommandPreview(binary: string, args: readonly string[]): string {
  return [binary, ...args].map((value) => /\s|["']/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value).join(" ");
}

export function planWebSetup(input: WebSetupInput): WebSetupPlan {
  if (!isAbsolutePath(input.engineCommand) || !isAbsolutePath(input.m9rHome) || !isAbsolutePath(input.extensionPath)) throw new Error("The engine command, extension path, and M9R_HOME must be absolute paths.");
  const selectedAgents = selectWebSetupAgents(input.detected, input.selectedAgents);
  const detected = new Map(input.detected.map((agent) => [agent.kind, agent]));
  const agentFiles = selectedAgents.map((agent) => {
    const path = input.configPaths[agent];
    if (!path || !isAbsolutePath(path)) throw new Error(`No absolute user config path was resolved for ${AGENT_LABELS[agent]}.`);
    return {
      agent,
      path,
      ...(agent === "opencode" ? { layout: webOpenCodeLayout(detected.get(agent)?.versionLine) } : {}),
    };
  });
  if (!/^[a-p]{32}$/.test(input.extensionId)) throw new Error("The browser extension ID is invalid.");
  return {
    selectedAgents,
    agentFiles,
    extensionPath: input.extensionPath,
    browsers: [...new Set(input.browsers)],
    allowedExtensionIds: webExtensionAllowlist({ developmentId: input.extensionId }),
    m9rHome: input.m9rHome,
  };
}

/** Selects a non-destructive uninstall action from hashes, never by comparing or printing user config contents. */
export function webConfigUninstallMode(input: {
  existedBefore: boolean;
  currentHash: string | null;
  installedHash: string | null;
}): WebConfigUninstallMode {
  if (!input.installedHash || !input.currentHash) return "unchanged";
  if (input.currentHash !== input.installedHash) return "remove-managed-entry";
  return input.existedBefore ? "restore-backup" : "delete-created-file";
}

/** Update only files still matching M9R's prior hash; never claim or overwrite untracked/user-edited files. */
export function webExtensionFileAction(input: {
  currentHash: string | null;
  installedHash: string | null;
  desiredHash?: string | null;
}): WebExtensionFileAction {
  if (input.currentHash === null) return input.desiredHash ? "write" : "unchanged";
  if (!input.installedHash || input.currentHash !== input.installedHash) return "preserve";
  if (!input.desiredHash) return "delete";
  return input.currentHash === input.desiredHash ? "unchanged" : "write";
}

export type ManagedWebExtensionSourceFile = { relativePath: string; desiredHash: string };
export type ManagedWebExtensionInstalledFile = { relativePath: string; installedHash: string };
export type ManagedWebExtensionRefreshPlan = {
  relativePath: string;
  desiredHash: string;
  installedHash: string | null;
  currentHash: string | null;
  action: Exclude<WebExtensionFileAction, "delete">;
};

/** Plan an extension-only refresh without claiming or overwriting untracked/user-edited files. */
export function planManagedWebExtensionRefresh(input: {
  sourceFiles: readonly ManagedWebExtensionSourceFile[];
  installedFiles: readonly ManagedWebExtensionInstalledFile[];
  currentHashes: ReadonlyMap<string, string | null>;
}): ManagedWebExtensionRefreshPlan[] {
  const normalizeRelativePath = (raw: string): string => {
    const path = raw.replace(/\\/g, "/");
    const segments = path.split("/");
    if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Unsafe managed extension relative path: ${raw}`);
    }
    return segments.join("/");
  };
  const installed = new Map<string, string>();
  for (const file of input.installedFiles) {
    const path = normalizeRelativePath(file.relativePath);
    if (installed.has(path)) throw new Error(`Duplicate managed extension path: ${path}`);
    installed.set(path, file.installedHash);
  }
  const seen = new Set<string>();
  return input.sourceFiles.map((file) => {
    const relativePath = normalizeRelativePath(file.relativePath);
    if (seen.has(relativePath)) throw new Error(`Duplicate extension source path: ${relativePath}`);
    seen.add(relativePath);
    if (!file.desiredHash) throw new Error(`Missing desired hash for extension source path: ${relativePath}`);
    const currentHash = input.currentHashes.get(relativePath) ?? null;
    const installedHash = installed.get(relativePath) ?? null;
    const action = webExtensionFileAction({ currentHash, installedHash, desiredHash: file.desiredHash });
    if (action === "delete") throw new Error(`Unexpected delete action for extension source path: ${relativePath}`);
    return { relativePath, desiredHash: file.desiredHash, installedHash, currentHash, action };
  });
}

export function parseWebSetupList(raw: string, valid: readonly string[], label: string): string[] {
  const values = [...new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const invalid = values.find((value) => !valid.includes(value));
  if (invalid) throw new Error(`Unknown ${label} "${invalid}". Choose ${valid.join(", ")}.`);
  return values;
}

export function codexWebMcpBlock(command: WebMcpCommand): string {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return [
    "# m9r-web-managed (maintained by M9R web setup)",
    "[mcp_servers.m9r]",
    `command = ${quote(command.command)}`,
    `args = [${command.args.map(quote).join(", ")}]`,
    "startup_timeout_sec = 30.0",
    "",
    "[mcp_servers.m9r.env]",
    `M9R_HOME = ${quote(command.m9rHome)}`,
    `M9R_WEB_BROKER_PORT = ${quote(String(command.brokerPort ?? 47821))}`,
  ].join("\n");
}

interface TomlSection { title: string; start: number; end: number; headerStart: number }

function tomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [];
  const headers: Array<{ title: string; start: number; headerStart: number }> = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/);
    if (match) headers.push({ title: match[1]!.trim(), start: offset, headerStart: offset });
    offset += line.length;
  }
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i]!;
    sections.push({ ...current, end: headers[i + 1]?.start ?? text.length });
  }
  return sections;
}

const OWN_CODEX_SECTIONS = new Set(["mcp_servers.m9r", "mcp_servers.m9r.env"]);

function managedCodexRange(text: string): { start: number; end: number } | null {
  const sections = tomlSections(text);
  const owned = sections.filter((section) => OWN_CODEX_SECTIONS.has(section.title));
  if (owned.length === 0) return null;
  let start = Math.min(...owned.map((section) => section.start));
  const marker = "# m9r-web-managed (maintained by M9R web setup)";
  const prefix = text.slice(0, start);
  const markerStart = prefix.lastIndexOf(marker);
  if (markerStart >= 0 && /^\s*$/.test(prefix.slice(markerStart + marker.length))) start = markerStart;
  return { start, end: Math.max(...owned.map((section) => section.end)) };
}

export function mergeCodexWebMcp(existing: string, command: WebMcpCommand): string {
  const block = codexWebMcpBlock(command);
  const owned = managedCodexRange(existing);
  if (!owned) {
    const separator = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
  }
  const before = existing.slice(0, owned.start);
  const after = existing.slice(owned.end);
  const separator = before.length > 0 && !before.endsWith("\n\n") ? "\n" : "";
  return `${before}${separator}${block}\n${after}`;
}

export function removeCodexWebMcp(existing: string): string {
  const owned = managedCodexRange(existing);
  if (!owned) return existing;
  return `${existing.slice(0, owned.start)}${existing.slice(owned.end)}`.replace(/\n{3,}/g, "\n\n");
}

interface JsoncProperty { key: string; keyStart: number; value: JsoncNode; commaStart?: number }
interface JsoncNode { kind: "object" | "array" | "scalar"; start: number; end: number; openOffset?: number; closeOffset?: number; properties?: JsoncProperty[]; items?: JsoncNode[] }

class JsoncReader {
  private index = 0;
  private readonly source: string;
  constructor(source: string) { this.source = source; }

  parse(): JsoncNode {
    this.skipTrivia();
    const value = this.readValue();
    this.skipTrivia();
    if (this.index !== this.source.length) throw new Error("unexpected content after JSON value");
    return value;
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index]!)) { this.index += 1; continue; }
      if (this.source.startsWith("//", this.index)) {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index += 1;
        continue;
      }
      if (this.source.startsWith("/*", this.index)) {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end < 0) throw new Error("unterminated JSONC comment");
        this.index = end + 2;
        continue;
      }
      break;
    }
  }

  private readString(): string {
    const start = this.index;
    if (this.source[this.index] !== '"') throw new Error("object keys must be quoted strings");
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === "\\") { this.index += 2; continue; }
      this.index += 1;
      if (char === '"') return JSON.parse(this.source.slice(start, this.index)) as string;
    }
    throw new Error("unterminated JSON string");
  }

  private readValue(): JsoncNode {
    this.skipTrivia();
    const start = this.index;
    const char = this.source[this.index];
    if (char === "{") return this.readObject();
    if (char === "[") return this.readArray();
    if (char === '"') { this.readString(); return { kind: "scalar", start, end: this.index }; }
    const match = this.source.slice(this.index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error("expected a JSON value");
    this.index += match[0].length;
    return { kind: "scalar", start, end: this.index };
  }

  private readObject(): JsoncNode {
    const start = this.index++;
    const properties: JsoncProperty[] = [];
    this.skipTrivia();
    while (this.source[this.index] !== "}") {
      if (this.index >= this.source.length) throw new Error("unterminated object");
      const keyStart = this.index;
      const key = this.readString();
      this.skipTrivia();
      if (this.source[this.index++] !== ":") throw new Error("expected colon after object key");
      const value = this.readValue();
      const property: JsoncProperty = { key, keyStart, value };
      this.skipTrivia();
      if (this.source[this.index] === ",") { property.commaStart = this.index++; this.skipTrivia(); }
      properties.push(property);
      if (this.source[this.index] === "}") break;
      if (property.commaStart === undefined) throw new Error("expected comma between object properties");
    }
    if (this.source[this.index] !== "}") throw new Error("unterminated object");
    const closeOffset = this.index++;
    return { kind: "object", start, end: this.index, openOffset: start, closeOffset, properties };
  }

  private readArray(): JsoncNode {
    const start = this.index++;
    const items: JsoncNode[] = [];
    this.skipTrivia();
    while (this.source[this.index] !== "]") {
      if (this.index >= this.source.length) throw new Error("unterminated array");
      items.push(this.readValue());
      this.skipTrivia();
      if (this.source[this.index] === ",") { this.index += 1; this.skipTrivia(); }
      else if (this.source[this.index] !== "]") throw new Error("expected comma between array values");
    }
    const closeOffset = this.index++;
    return { kind: "array", start, end: this.index, openOffset: start, closeOffset, items };
  }
}

function parseJsonc(source: string): JsoncNode {
  try { return new JsoncReader(source).parse(); }
  catch (error) { throw new Error(`OpenCode config is invalid JSONC (${error instanceof Error ? error.message : "parse error"}); it was not changed.`); }
}

function objectProperty(node: JsoncNode, key: string): JsoncProperty | undefined {
  return node.kind === "object" ? node.properties?.find((property) => property.key === key) : undefined;
}

function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return source.slice(lineStart, offset).match(/^\s*/)?.[0] ?? "";
}

function setJsoncProperty(source: string, node: JsoncNode, key: string, value: unknown): string {
  if (node.kind !== "object" || node.closeOffset === undefined) throw new Error("OpenCode config parent is not an object; it was not changed.");
  const existing = objectProperty(node, key);
  const serialized = JSON.stringify(value, null, 2);
  if (existing) return source.slice(0, existing.value.start) + serialized + source.slice(existing.value.end);
  const properties = node.properties ?? [];
  const parentIndent = indentAt(source, node.closeOffset);
  const childIndent = `${parentIndent}  `;
  const formatted = `\n${childIndent}${JSON.stringify(key)}: ${serialized}`;
  if (properties.length === 0) {
    return source.slice(0, node.closeOffset) + formatted + `\n${parentIndent}` + source.slice(node.closeOffset);
  }
  const last = properties[properties.length - 1]!;
  if (last.commaStart !== undefined) {
    const at = last.commaStart + 1;
    return source.slice(0, at) + formatted + source.slice(at);
  }
  return source.slice(0, last.value.end) + `,${formatted}` + source.slice(last.value.end);
}

function removeJsoncProperty(source: string, node: JsoncNode, key: string): string {
  const properties = node.properties ?? [];
  const index = properties.findIndex((property) => property.key === key);
  if (index < 0) return source;
  const property = properties[index]!;
  if (index < properties.length - 1) {
    const end = property.commaStart;
    if (end === undefined) throw new Error("OpenCode config property delimiters are invalid; it was not changed.");
    return source.slice(0, property.keyStart) + source.slice(end + 1);
  }
  if (index > 0) {
    const separator = properties[index - 1]!.commaStart;
    if (separator === undefined) throw new Error("OpenCode config property delimiters are invalid; it was not changed.");
    return source.slice(0, separator) + source.slice(property.value.end);
  }
  return source.slice(0, property.keyStart) + source.slice(property.value.end);
}

function mcpTarget(node: JsoncNode, layout: WebOpenCodeLayout): { parent: JsoncNode; key: string } {
  const mcpProperty = objectProperty(node, "mcp");
  if (!mcpProperty) return { parent: node, key: "mcp" };
  if (mcpProperty.value.kind !== "object") throw new Error("OpenCode config `mcp` must be an object; it was not changed.");
  if (layout === "legacy") return { parent: mcpProperty.value, key: "m9r" };
  const servers = objectProperty(mcpProperty.value, "servers");
  if (!servers) return { parent: mcpProperty.value, key: "servers" };
  if (servers.value.kind !== "object") throw new Error("OpenCode config `mcp.servers` must be an object; it was not changed.");
  return { parent: servers.value, key: "m9r" };
}

function openCodeEntry(command: WebMcpCommand): Record<string, unknown> {
  return {
    type: "local",
    command: [command.command, ...command.args],
    environment: { M9R_HOME: command.m9rHome, M9R_WEB_BROKER_PORT: String(command.brokerPort ?? 47821) },
  };
}

export function mergeOpenCodeWebMcp(existing: string, layout: WebOpenCodeLayout, command: WebMcpCommand): string {
  let source = existing.trim() ? existing : "{}\n";
  let root = parseJsonc(source);
  if (root.kind !== "object") throw new Error("OpenCode config root must be an object; it was not changed.");
  let mcp = objectProperty(root, "mcp");
  if (!mcp) {
    source = setJsoncProperty(source, root, "mcp", {});
    root = parseJsonc(source);
    mcp = objectProperty(root, "mcp");
  }
  if (!mcp || mcp.value.kind !== "object") throw new Error("OpenCode config `mcp` must be an object; it was not changed.");
  if (layout === "servers" && !objectProperty(mcp.value, "servers")) {
    source = setJsoncProperty(source, mcp.value, "servers", {});
    root = parseJsonc(source);
    mcp = objectProperty(root, "mcp");
  }
  if (!mcp || mcp.value.kind !== "object") throw new Error("OpenCode config `mcp` must be an object; it was not changed.");
  const target = mcpTarget(root, layout);
  return setJsoncProperty(source, target.parent, target.key, layout === "servers" && target.key === "servers" ? { m9r: openCodeEntry(command) } : openCodeEntry(command));
}

export function removeOpenCodeWebMcp(existing: string, layout: WebOpenCodeLayout): string {
  if (!existing.trim()) return existing;
  const root = parseJsonc(existing);
  if (root.kind !== "object") return existing;
  const mcp = objectProperty(root, "mcp")?.value;
  if (!mcp || mcp.kind !== "object") return existing;
  if (layout === "legacy") return removeJsoncProperty(existing, mcp, "m9r");
  const servers = objectProperty(mcp, "servers")?.value;
  return servers?.kind === "object" ? removeJsoncProperty(existing, servers, "m9r") : existing;
}
