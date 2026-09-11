/**
 * Provider-neutral local adapter configuration.
 *
 * This module validates operator-authored local adapter configuration only.
 * It does not connect to M9R Cloud, execute a command, or store credentials.
 */

export const PROVIDER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PROVIDER_ADAPTER_PROTOCOL = "acp-stdio" as const;
export const PROVIDER_JSON_STDIO_PROTOCOL = "oathlock-json-stdio" as const;
export const PROVIDER_ADAPTER_PROTOCOLS = [PROVIDER_ADAPTER_PROTOCOL, PROVIDER_JSON_STDIO_PROTOCOL] as const;

export interface ProviderAdapterConfig {
  provider: string;
  command: string;
  args: string[];
  shell: boolean;
  label?: string;
  protocol: (typeof PROVIDER_ADAPTER_PROTOCOLS)[number];
}

export type ProviderAdapterConfigValidation =
  | { ok: true; value: ProviderAdapterConfig }
  | { ok: false; error: string };

const COMMAND_PATTERN = /^[a-zA-Z0-9._\\/: -]{1,256}$/;
const ARG_MAX_LENGTH = 512;
const MAX_ARGS = 32;

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

export function providerAdapterId(provider: string): string {
  const normalized = cleanText(provider, 40).toLowerCase();
  if (normalized === "codex") return "codex-acp";
  if (normalized === "claude-code") return "claude-agent-acp";
  if (normalized === "opencode") return "opencode-acp";
  return `${normalized || "provider"}-acp`;
}

export function providerMention(providerOrAdapter: string): string {
  const normalized = cleanText(providerOrAdapter, 128).toLowerCase().replace(/_/g, "-");
  if (normalized === "claude" || normalized === "claude-agent-acp" || normalized.startsWith("claude-code")) return "claude-code";
  if (normalized === "opencode-acp" || normalized.startsWith("opencode")) return "opencode";
  if (normalized === "codex-acp" || normalized === "codex") return "codex";
  return normalized.endsWith("-acp") ? normalized.slice(0, -4) : normalized;
}

export function providerLabel(provider: string): string {
  const normalized = cleanText(provider, 128).toLowerCase();
  if (normalized === "codex" || normalized === "codex-acp") return "Codex";
  if (normalized === "claude-code" || normalized === "claude-agent-acp") return "Claude";
  if (normalized === "opencode" || normalized === "opencode-acp") return "OpenCode";
  if (normalized === "grok-build") return "Grok Build";
  return providerMention(normalized)
    .split("-")
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Connected agent";
}

export function parseProviderAdapterConfig(raw: unknown, provider: string): ProviderAdapterConfigValidation {
  const normalizedProvider = cleanText(provider, 40).toLowerCase();
  if (!PROVIDER_SLUG_PATTERN.test(normalizedProvider)) return { ok: false, error: "provider is not a valid slug" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "adapter config must be an object" };
  const row = raw as Record<string, unknown>;
  const protocol = row.protocol === undefined ? PROVIDER_ADAPTER_PROTOCOL : row.protocol;
  if (!PROVIDER_ADAPTER_PROTOCOLS.includes(protocol as (typeof PROVIDER_ADAPTER_PROTOCOLS)[number])) return { ok: false, error: "unsupported adapter protocol" };
  const command = cleanText(row.command, 256);
  if (!command || !COMMAND_PATTERN.test(command)) return { ok: false, error: "adapter command is invalid" };
  const argsRaw = row.args === undefined ? [] : row.args;
  if (!Array.isArray(argsRaw) || argsRaw.length > MAX_ARGS) return { ok: false, error: "adapter args must be a bounded array" };
  const args = argsRaw.map((value) => cleanText(value, ARG_MAX_LENGTH));
  if (args.some((value) => !value || /[\u0000-\u001f\u007f]/.test(value))) return { ok: false, error: "adapter args contain invalid content" };
  const shell = row.shell === true;
  if (shell && [command, ...args].some((value) => /[&|<>`;$()]/.test(value))) return { ok: false, error: "shell adapter command contains unsafe metacharacters" };
  const label = row.label === undefined ? undefined : cleanText(row.label, 120);
  return {
    ok: true,
    value: {
      provider: normalizedProvider,
      command,
      args,
      shell,
      ...(label ? { label } : {}),
      protocol: protocol as (typeof PROVIDER_ADAPTER_PROTOCOLS)[number],
    },
  };
}
