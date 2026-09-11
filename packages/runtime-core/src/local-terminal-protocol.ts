export const BRIDGE_PROTOCOL_VERSION = "oathlock-terminal-v1" as const;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_BRIDGE_PORT = 43117;
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
export const MAX_BRIDGE_MESSAGE_BYTES = 128 * 1024;

export const PROVIDER_LAUNCHERS = {
  "claude-code": { label: "Claude", command: "claude", args: [] },
  codex: { label: "Codex", command: "codex", args: [] },
  "grok-build": { label: "Grok Build", command: "grok", args: [] },
} as const;

export type TerminalProvider = string;

export function isTerminalProvider(value: unknown): value is TerminalProvider {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value);
}
