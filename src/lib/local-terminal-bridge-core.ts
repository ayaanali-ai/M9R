import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_MESSAGE_BYTES, MAX_TERMINAL_INPUT_BYTES, isTerminalProvider, type TerminalProvider } from "@/lib/local-terminal-protocol";
export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, MAX_BRIDGE_MESSAGE_BYTES, MAX_TERMINAL_INPUT_BYTES, PROVIDER_LAUNCHERS, isTerminalProvider, type TerminalProvider } from "@/lib/local-terminal-protocol";

/**
 * The terminal bridge is loopback-only, but loopback plus Origin is not
 * authentication: another local process can open the socket without a
 * browser Origin header. Keep the bearer in a dedicated WebSocket subprotocol
 * (or an HttpOnly bootstrap cookie for the local workspace page).
 */
export const BRIDGE_TOKEN_PROTOCOL_PREFIX = "oathlock-bridge.";
export const BRIDGE_TOKEN_COOKIE = "m9r_terminal_bridge";

const TERMINAL_WATCH_GENERATED_DIRECTORIES = new Set([
  ".git", "node_modules", ".next", ".m9r", "dist", "cli",
  ".workcache", ".test-tmp", ".cache", "target", "coverage",
  ".worktrees", ".release-excluded", ".wrangler", ".vercel", ".playwright-mcp", ".gstack",
]);

const TERMINAL_WATCH_SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx",
]);

/**
 * Sensitive configuration and credential material is never read by the
 * resident file watcher. The watcher is a convenience activity feed, not a
 * secret-export mechanism; metadata about a sensitive path is safe, its
 * contents are not.
 */
export function isSensitiveTerminalWatchPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => {
    const lower = segment.toLowerCase();
    if (!lower) return false;
    if (lower === ".env" || lower.startsWith(".env.") || lower === ".envrc") return true;
    if (lower === ".npmrc" || lower === ".pypirc" || lower === ".netrc") return true;
    if (lower === "credentials" || lower.startsWith("credentials.")) return true;
    if (lower === "secrets" || lower.startsWith("secrets.")) return true;
    if (lower === "private" || lower.startsWith("private.")) return true;
    if ([...TERMINAL_WATCH_SENSITIVE_EXTENSIONS].some((extension) => lower.endsWith(extension))) return true;
    return /(?:webhook|secret|credential|private|signing)[._-]?(?:config|settings|secrets?)?\.(?:json|ya?ml|toml|ini|cfg|conf|env)$/i.test(lower);
  });
}

/** Exclude generated trees before enumeration, while retaining untracked source. */
export function isIgnoredTerminalWatchPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => TERMINAL_WATCH_GENERATED_DIRECTORIES.has(segment)
    || segment.startsWith(".m9r-web-broker-") || segment.startsWith(".m9r-coordinator-worker-"))
    || isSensitiveTerminalWatchPath(relativePath);
}

export type BridgeClientMessage =
  | { type: "list" }
  | { type: "spawn"; provider: TerminalProvider; cwd: string; cols: number; rows: number }
  | { type: "attach"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "report-state"; sessionId: string; state: "idle" | "working" | "blocked" }
  | { type: "close"; sessionId: string };

export function createBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function bridgeTokenProtocol(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("The terminal bridge token is invalid.");
  return `${BRIDGE_TOKEN_PROTOCOL_PREFIX}${token}`;
}

export function bridgeTokenFromProtocols(protocols: readonly string[]): string | null {
  const value = protocols.find((protocol) => protocol.startsWith(BRIDGE_TOKEN_PROTOCOL_PREFIX));
  const token = value?.slice(BRIDGE_TOKEN_PROTOCOL_PREFIX.length) ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function bridgeTokensEqual(expected: string, provided: string | null | undefined): boolean {
  if (!provided || !/^[A-Za-z0-9_-]{43}$/.test(expected) || !/^[A-Za-z0-9_-]{43}$/.test(provided)) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function providerProcessSpec(_provider: TerminalProvider, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo"] }
    : { command: "/bin/sh", args: ["-l"] };
}

export function authorizeUpgrade(input: {
  origin: string | undefined;
  protocols: string[];
  allowedOrigins: string[];
  bridgeToken: string;
  providedToken?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.origin || !input.allowedOrigins.includes(input.origin)) {
    return { ok: false, reason: "Origin is not allowed." };
  }
  if (!input.protocols.includes(BRIDGE_PROTOCOL_VERSION)) {
    return { ok: false, reason: "Terminal bridge protocol is missing." };
  }
  if (!bridgeTokensEqual(input.bridgeToken, input.providedToken ?? bridgeTokenFromProtocols(input.protocols))) {
    return { ok: false, reason: "Terminal bridge authentication is missing or invalid." };
  }
  return { ok: true };
}

export function resolveWorkspaceCwd(repositoryRoot: string, requestedCwd: string): string {
  if (!repositoryRoot.trim()) throw new Error("A repository root is required.");
  if (!requestedCwd.trim()) throw new Error("A workspace cwd is required.");
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, requestedCwd);
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error("Requested cwd is outside the configured repository root.");
  }
  return candidate;
}

function boundedDimension(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : fallback;
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new Error("A valid terminal session id is required.");
  }
  return value;
}

export function parseClientMessage(raw: string): BridgeClientMessage {
  if (Buffer.byteLength(raw) > MAX_BRIDGE_MESSAGE_BYTES) throw new Error("Terminal bridge message is too large.");
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("Terminal bridge messages must be valid JSON.");
  }
  if (!input || typeof input !== "object") throw new Error("Terminal bridge message must be an object.");
  const message = input as Record<string, unknown>;

  switch (message.type) {
    case "list":
      return { type: "list" };
    case "spawn": {
      if (!isTerminalProvider(message.provider)) {
        throw new Error("Invalid provider for terminal session.");
      }
      const cwd = typeof message.cwd === "string" ? message.cwd : ".";
      if (!cwd || cwd.length > 500) throw new Error("A valid workspace cwd is required.");
      return {
        type: "spawn",
        provider: message.provider as TerminalProvider,
        cwd,
        cols: boundedDimension(message.cols, 100, 400),
        rows: boundedDimension(message.rows, 30, 200),
      };
    }
    case "attach":
      return { type: "attach", sessionId: requiredSessionId(message.sessionId) };
    case "input": {
      const data = typeof message.data === "string" ? message.data : "";
      if (Buffer.byteLength(data) > MAX_TERMINAL_INPUT_BYTES) throw new Error("Terminal input is too large.");
      return { type: "input", sessionId: requiredSessionId(message.sessionId), data };
    }
    case "resize":
      return {
        type: "resize",
        sessionId: requiredSessionId(message.sessionId),
        cols: boundedDimension(message.cols, 100, 400),
        rows: boundedDimension(message.rows, 30, 200),
      };
    case "report-state": {
      if (message.state !== "idle" && message.state !== "working" && message.state !== "blocked") {
        throw new Error("Invalid terminal agent state.");
      }
      return { type: "report-state", sessionId: requiredSessionId(message.sessionId), state: message.state };
    }
    case "close":
      return { type: "close", sessionId: requiredSessionId(message.sessionId) };
    default:
      throw new Error("Unsupported terminal bridge message type.");
  }
}
