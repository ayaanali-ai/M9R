/**
 * Detects which coding-agent CLIs (Claude Code, Codex, OpenCode) are
 * actually installed on this machine, without needing to run from inside
 * any of their own processes.
 *
 * Real install/PATH facts this relies on (verified against each vendor's
 * current docs, not assumed):
 *  - Claude Code: binary `claude` on PATH across every documented install
 *    method (native installer, Homebrew, WinGet, apt/dnf/apk, npm).
 *    https://code.claude.com/docs/en/setup
 *  - Codex: binary `codex` on PATH (npm global install, Homebrew cask, or
 *    a direct release binary). https://www.npmjs.com/package/@openai/codex
 *  - OpenCode: binary `opencode` on PATH (npm global install or the
 *    official install script). https://opencode.ai/docs/
 *
 * `claude --version` / `codex --version` / `opencode --version` are cheap,
 * documented, side-effect-free checks for all three -- none of them start a
 * real agent session. A version check only proves the CLI is installed; it
 * proves nothing about whether that install is logged in, and this module
 * deliberately does not claim otherwise (see `DetectedAgent.kind` docs).
 */

export const DETECTABLE_AGENT_KINDS = ["claude-code", "codex", "opencode"] as const;
export type DetectableAgentKind = (typeof DETECTABLE_AGENT_KINDS)[number];

interface DetectorSpec {
  kind: DetectableAgentKind;
  binary: string;
  label: string;
}

const DETECTORS: DetectorSpec[] = [
  { kind: "claude-code", binary: "claude", label: "Claude Code" },
  { kind: "codex", binary: "codex", label: "Codex" },
  { kind: "opencode", binary: "opencode", label: "OpenCode" },
];

export interface DetectedAgent {
  kind: DetectableAgentKind;
  label: string;
  binary: string;
  /** First line of `--version` output, trimmed. Never parsed further -- version format is not a contract we depend on. */
  versionLine: string;
}

/**
 * Injected so the detection logic is unit-testable with no real process
 * spawning. The real implementation (wired in scripts/m9r-cli.ts) runs
 * `<binary> --version` with a short timeout and returns its stdout on a
 * zero exit code, null on anything else (not found, non-zero exit, or a
 * hang past the timeout -- a hung probe must never block setup).
 */
export type VersionProbe = (binary: string) => Promise<string | null>;

/**
 * Detects every known agent CLI present on PATH. Probes run one at a time,
 * not in parallel -- these commands are near-instant, and sequential probing
 * keeps a single slow/hanging install from being masked by faster ones
 * finishing first in a Promise.all (a partial detection result must be
 * attributable to the probe that actually stalled, not silently dropped).
 */
export async function detectInstalledAgents(probe: VersionProbe): Promise<DetectedAgent[]> {
  const found: DetectedAgent[] = [];
  for (const detector of DETECTORS) {
    const output = await probe(detector.binary);
    if (output == null) continue;
    const versionLine = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
    found.push({ kind: detector.kind, label: detector.label, binary: detector.binary, versionLine });
  }
  return found;
}

/** Parses a comma-separated `--agents` override into known detectable kinds, ignoring blanks. Unknown kinds pass through unchanged -- `connect` accepts any provider slug, same as `init --agent-kind` always has. */
export function parseAgentsFlag(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
