/**
 * M9R bootstrap core — repo-native automatic agent workflow
 * ----------------------------------------------------------------------------
 * After a human approves a connection, `m9r bootstrap` installs a managed
 * instruction block into the repo file the connected agent already reads
 * (AGENTS.md for Codex/Grok Build, CLAUDE.md for Claude Code). Supported agents
 * then use M9R during normal repo tasks without
 * the user saying "use M9R" in every prompt.
 *
 * Honesty contract:
 *  - This is instruction installation, not interception. M9R cannot force
 *    an external agent process to comply; automatic behavior depends on the
 *    agent reading the installed repo instructions.
 *  - The managed block never contains tokens, claim URLs, or local config.
 *  - User-authored content around the block is preserved byte-for-byte.
 *
 * Everything here is pure string/path logic so the CLI command is unit-testable
 * with injected IO.
 */

import type { SupportedAgentKind } from "@/lib/oathlock-cli-core";

export const OATHLOCK_WORKFLOW_BLOCK_VERSION = 6;

export const WORKFLOW_START_MARKER = "<!-- OATHLOCK:AUTOMATIC-WORKFLOW:START";
export const WORKFLOW_END_MARKER = "<!-- OATHLOCK:AUTOMATIC-WORKFLOW:END -->";

const START_LINE = `${WORKFLOW_START_MARKER} v${OATHLOCK_WORKFLOW_BLOCK_VERSION} -->`;

export const AGENT_KIND_LABEL: Record<SupportedAgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude",
  "grok-build": "Grok Build",
  opencode: "OpenCode",
  other: "Other",
};

/**
 * A connected agent kind is now any well-formed provider name, not just the
 * ones above with real integration (see agent-join.ts's AGENT_KIND_SLUG_
 * PATTERN comment) -- so label lookup needs a graceful fallback instead of
 * assuming every kind is a key of AGENT_KIND_LABEL. Falls back to a
 * title-cased version of the raw slug (e.g. "gemini-cli" -> "Gemini Cli")
 * rather than printing the raw slug or "undefined".
 */
export function agentKindLabel(kind: string): string {
  const known = AGENT_KIND_LABEL[kind as SupportedAgentKind];
  if (known) return known;
  return kind.split("-").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export interface BootstrapTarget {
  /** Repo-relative path of the instruction file this agent kind reads. */
  file: string;
  /** Whether the agent kind is documented to auto-read this file. */
  automatic: boolean;
  /** Frontmatter/preamble used only when creating the file from scratch. */
  newFilePreamble: string;
}

/**
 * The repo instruction file each supported agent reads automatically.
 *  - Codex, Grok Build, and OpenCode all read the portable AGENTS.md.
 *  - Claude Code reads CLAUDE.md.
 *  - Any other connected agent kind (not just the literal word "other") gets
 *    the documented manual path (OATHLOCK.md), no automatic claim -- it's
 *    the honest default for a real, distinct provider name we simply don't
 *    have specific bootstrap integration for yet, not an error case.
 */
export function bootstrapTargetFor(kind: string): BootstrapTarget {
  switch (kind) {
    case "codex":
    case "grok-build":
    case "opencode":
      return { file: "AGENTS.md", automatic: true, newFilePreamble: "" };
    case "claude-code":
      return { file: "CLAUDE.md", automatic: true, newFilePreamble: "" };
    default:
      return { file: "OATHLOCK.md", automatic: false, newFilePreamble: "" };
  }
}

/**
 * The managed instruction block. Operational, concise, and bounded: agents may
 * verify/load/start/attach/check/prepare/wait automatically; only humans review,
 * accept, or approve what M9R records.
 */
export function buildWorkflowBlock(kind: string): string {
  const target = bootstrapTargetFor(kind);
  const manualNote =
    !target.automatic
      ? [
          "",
          "> Automatic loading is NOT assured for this agent. Paste this workflow",
          "> into the agent's instructions, or have it read OATHLOCK.md at session start.",
        ]
      : [];

  return [
    START_LINE,
    "## M9R — automatic controlled-run workflow (managed block; do not edit by hand)",
    "",
    target.file === "AGENTS.md"
      ? "This repo is connected to M9R. This is a shared repository workflow for multiple agent identities."
      : "This repo is connected to M9R through an approved agent connection.",
    "Your identity is resolved from your authenticated M9R connection; never infer it from this file or another agent's local files.",
    "Runs and evidence are attributed to that approved connection automatically —",
    "never claim a different agent identity.",
    "",
    "Resident provider launches: when `OATHLOCK_RESIDENT_CHILD=1` is present, the parent controlled run owns M9R governance for this task.",
    "In that case, do not run M9R doctor, rules, whoami, run, inbox, or status commands and do not prepare an M9R Evidence Draft; follow the supplied bounded assignment and return its requested result.",
    ...manualNote,
    "",
    "Apply this workflow automatically to any task that modifies or analyzes this",
    "repo: changing code, debugging, running tests, editing configuration,",
    "reviewing implementation behavior, or preparing a technical change. The user",
    "does not need to say \"use M9R\". Do NOT start a controlled run for",
    "casual conversation, general programming questions, or tasks unrelated to",
    "this repo.",
    "",
    "### Before editing",
    "1. Verify the connection: `npx m9r-cli doctor`. If it reports no token or a",
    "   revoked/disconnected connection, stop M9R-controlled work and report",
    "   that a human must reconnect with `npx m9r-cli init`. Never reconnect on",
    "   your own.",
    "2. Load active repo rules: `npx m9r-cli rules`. If rules cannot be loaded,",
    "   stop and report instead of proceeding uncontrolled.",
    "3. Run `npx m9r-cli whoami`, then check only the current runtime's scoped",
    "   run pointer at `.oathlock/agents/<authenticated-kind>/run.json` (never",
    "   read another provider's pointer or `.oathlock/local.json`). If it",
    "   references a run for THIS task, attach to it and keep reporting under that",
    "   run id. Otherwise start exactly one controlled run:",
    "   `npx m9r-cli run start --task \"<short task title>\"`.",
    "   If the human explicitly asks this agent to collaborate, select the requested",
    "   collaboration level: omit `--mode` for `solo`, use `--mode coordinated` for",
    "   selective bounded help, `--mode assurance` when one",
    "   independent secondary decision is required before completion, or `--mode collaborative`",
    "   for several bounded assignments throughout the run. Normal single-agent work remains `solo`,",
    "   so M9R never creates extra provider usage without that human-selected mode.",
    "   Never create a second run for the same task, and never attach to an",
    "   unrelated or historical run — old runs are history, not current work.",
    "4. Check the Agent Inbox: `npx m9r-cli inbox`.",
    "",
    "### During work",
    "- Follow the loaded rules and stay within the assigned task.",
    "- Re-check `npx m9r-cli inbox` at logical checkpoints and incorporate human",
    "  instructions where applicable. `npx m9r-cli inbox` also surfaces open",
    "  conversations from other connected agents, and auto-starts a run here for",
    "  any handoff addressed to this connection -- that run appears the same as",
    "  any other, both in this session and on the Watchfloor.",
    "- For a quick question or a second opinion from another connected agent, ask it",
    "  directly and wait for the answer: `npx m9r-cli ask <agent> \"<question>\" --wait`",
    "  (it posts in #general; the reply prints here).",
    "- If part of the task is better handled by a different connected agent (a",
    "  distinct capability, or independent double-checking), hand it off instead",
    "  of doing it yourself: `npx m9r-cli conversation start --topic \"<short",
    "  topic>\" --with <agent>` then `npx m9r-cli conversation send --conversation",
    "  <id> --to <agent> --type handoff --text \"<what they should do>\"`. Only use",
    "  `--type handoff` for work you actually want them to run -- plain",
    "  `--type message` never starts anything.",
    "- If something worth a human's attention turns up that isn't part of the",
    "  current task (a risk, a misconfiguration, unexpected behavior, a gap in",
    "  the rules you were given) -- capture it as a Finding, not only a mention",
    "  in prose: `npx m9r-cli finding publish --title \"<short>\" --observed",
    "  \"<what you actually saw>\" [--evidence-level",
    "  inferred|correlated|command_tied] [--suggested \"<fix>\"]`.",
    "  A published finding starts hidden pending human review -- it is a flag,",
    "  not a fix, an accusation, or an automatic scan result.",
    "- Report progress sparingly: `npx m9r-cli run status --phase \"<short phase>\"`.",
    "- In coordinated or collaborative mode, invoke a secondary provider only through a",
    "  bounded `m9r coordinate request` with a distinct purpose, repository scope,",
    "  acceptance criteria, token ceiling, and latency ceiling. In assurance mode, request",
    "  one independent check and explicitly adopt, reject, or challenge its returned result",
    "  before completion. Secondary agents never delegate recursively.",
    "- Do not claim a rule or instruction was followed without supporting evidence.",
    "- Never expose secrets, tokens, environment values, local config, or private",
    "  data in output, evidence, or run telemetry.",
    "",
    "### Before finishing",
    "1. Check `npx m9r-cli inbox` one final time.",
    "2. Run the smallest relevant verification commands for the change.",
    "3. Prepare and include at the end of the final response a redacted `M9R Evidence Draft`,",
    "   using this exact field order (matches the m9r.evidence.v1 contract stored server-side):",
    "   `Agent:`, `Task:`, `Controlled run:`, `Active rules loaded:`, `Inbox status:`,",
    "   `Scope changes:`, `Changes (files):`, `Verification (command/result):`, `Failed commands:`,",
    "   `Limitations:`, `Sensitive areas:`, and",
    "   `Status: Awaiting human approval`. Use actual verification commands and actual pass/fail results.",
    "   Never claim a command passed unless it was run. State limitations or `None identified`.",
    "   Redact tokens, cookies, claim URLs, environment values, private keys,",
    "   raw local configuration or `.oathlock` config contents.",
    "4. After preparing the draft, set the run to waiting for human review:",
    "   `npx m9r-cli run status --phase \"waiting for human review\"`.",
    "5. Do not submit, approve, or record the draft until a human explicitly approves that exact draft.",
    "   You may create a temporary submission artifact and run only after a human has approved that exact draft:",
    "   `npx m9r-cli submit-session <file> --approved`; the artifact must not be committed or staged",
    "   and the recorded evidence must materially match the approved draft.",
    "   Never mark your own work reviewed or accepted, never record a human review decision,",
    "   and never claim human approval.",
    "6. Do not commit, push, deploy, publish, stage files, or run migrations",
    "   unless the task explicitly authorizes it.",
    "",
    "Agent prepares evidence. Human approves what M9R records. The Run",
    "Passport summarizes the reviewed record.",
    WORKFLOW_END_MARKER,
  ].join("\n");
}

export type ApplyAction = "created" | "installed" | "updated" | "unchanged";

export interface ApplyResult {
  content: string;
  changed: boolean;
  action: ApplyAction;
}

function blockBounds(content: string): { start: number; end: number } | null {
  const start = content.indexOf(WORKFLOW_START_MARKER);
  if (start === -1) return null;
  const endMarker = content.indexOf(WORKFLOW_END_MARKER, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + WORKFLOW_END_MARKER.length };
}

/**
 * Insert or update the managed block. User content before/after the block is
 * preserved exactly; a missing block is appended with a separating blank line;
 * an existing block (any version) is replaced in place; identical content is a
 * no-op. Never produces duplicate blocks.
 */
export function applyWorkflowBlock(
  existing: string | null,
  kind: string,
): ApplyResult {
  const block = buildWorkflowBlock(kind);
  const target = bootstrapTargetFor(kind);

  if (existing == null) {
    const preamble = target.newFilePreamble;
    return { content: `${preamble}${block}\n`, changed: true, action: "created" };
  }

  const bounds = blockBounds(existing);
  if (!bounds) {
    const separator = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { content: `${existing}${separator}${block}\n`, changed: true, action: "installed" };
  }

  const next = existing.slice(0, bounds.start) + block + existing.slice(bounds.end);
  if (next === existing) return { content: existing, changed: false, action: "unchanged" };
  return { content: next, changed: true, action: "updated" };
}

export interface WorkflowBlockStatus {
  present: boolean;
  version: number | null;
  /** Present AND matches the current block content exactly. */
  current: boolean;
}

export function inspectWorkflowBlock(
  content: string | null,
  kind: string,
): WorkflowBlockStatus {
  if (content == null) return { present: false, version: null, current: false };
  const bounds = blockBounds(content);
  if (!bounds) return { present: false, version: null, current: false };
  const installed = content.slice(bounds.start, bounds.end);
  const versionMatch = installed.match(/OATHLOCK:AUTOMATIC-WORKFLOW:START v(\d+)/);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  return { present: true, version, current: installed === buildWorkflowBlock(kind) };
}

export interface RemoveResult {
  content: string;
  changed: boolean;
}

/** Remove only the managed block; user-authored content is untouched. */
export function removeWorkflowBlock(existing: string): RemoveResult {
  const bounds = blockBounds(existing);
  if (!bounds) return { content: existing, changed: false };
  // Also consume one trailing newline left behind by the block, but nothing else.
  let end = bounds.end;
  if (existing[end] === "\n") end += 1;
  const before = existing.slice(0, bounds.start);
  const after = existing.slice(end);
  // Collapse the separator we added on install (at most one blank line).
  const content = before.endsWith("\n\n") && (after === "" || after.startsWith("\n"))
    ? before.slice(0, -1) + after
    : before + after;
  return { content, changed: true };
}
