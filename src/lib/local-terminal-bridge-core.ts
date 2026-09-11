import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_MESSAGE_BYTES, MAX_TERMINAL_INPUT_BYTES, isTerminalProvider, type TerminalProvider } from "@/lib/local-terminal-protocol";
export { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, MAX_BRIDGE_MESSAGE_BYTES, MAX_TERMINAL_INPUT_BYTES, PROVIDER_LAUNCHERS, isTerminalProvider, type TerminalProvider } from "@/lib/local-terminal-protocol";

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

export function providerProcessSpec(_provider: TerminalProvider, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo"] }
    : { command: "/bin/sh", args: ["-l"] };
}

export function authorizeUpgrade(input: {
  origin: string | undefined;
  protocols: string[];
  allowedOrigins: string[];
}): { ok: true } | { ok: false; reason: string } {
  if (!input.origin || !input.allowedOrigins.includes(input.origin)) {
    return { ok: false, reason: "Origin is not allowed." };
  }
  if (!input.protocols.includes(BRIDGE_PROTOCOL_VERSION)) {
    return { ok: false, reason: "Terminal bridge protocol is missing." };
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
