import { buildRunContract, type RunContract } from "@/lib/run-contract-service";

export const M9R_RULES_COMMAND = "npx m9r-cli@latest rules";
export const M9R_INBOX_COMMAND = "npx --yes m9r-cli@latest inbox";

export type HandoffEvidenceState = "waiting" | "submitted";

export interface RunHandoffInput {
  runId: string;
  agentName?: string | null;
  agentKind?: string | null;
  task?: string | null;
  startedAt?: string | null;
  preflightStatus?: string | null;
  preflightRisk?: string | null;
  activeRuleCount?: number | null;
  hasEvidence?: boolean | null;
}

export interface RunHandoff {
  identity: {
    runId: string;
    agent: string | null;
    task: string;
    startedAt: string | null;
    preflight: string | null;
  };
  rulesCommand: string;
  rulesCommandHelp: string;
  inboxCommand: string;
  inboxCommandHelp: string;
  agentPrompt: string;
  runContract: RunContract;
  evidenceTemplate: string;
  evidenceState: HandoffEvidenceState;
  evidenceStatusLabel: string;
  passportActionLabel: "View Run Passport";
}

const DEFAULT_TASK = "Describe the task here.";
const RULES_COMMAND_HELP =
  "Run this in the same repo before asking your AI coding agent to work. It returns only active M9R rules.";
const INBOX_COMMAND_HELP =
  "Pull instructions with the CLI. The connected agent reads dashboard instructions from its Agent inbox.";

function compactWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|oak_[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_-]{6,}|github_pat_[A-Za-z0-9_-]{6,})\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, "[path]")
    .replace(/\/(?:Users|home)\/[^\s,;]+/g, "[path]");
}

function cleanDisplayText(value: string | null | undefined, fallback: string, maxLength = 1000): string {
  if (typeof value !== "string") return fallback;
  const cleaned = compactWhitespace(redactSensitiveText(value)).slice(0, maxLength).trim();
  return cleaned || fallback;
}

function cleanOptionalText(value: string | null | undefined, maxLength = 120): string | null {
  if (typeof value !== "string") return null;
  const cleaned = compactWhitespace(redactSensitiveText(value)).slice(0, maxLength).trim();
  return cleaned || null;
}

function agentLabel(input: Pick<RunHandoffInput, "agentName" | "agentKind">): string | null {
  const name = cleanOptionalText(input.agentName);
  const kind = cleanOptionalText(input.agentKind);
  if (name && kind) return `${name} (${kind})`;
  return name ?? kind;
}

function preflightLabel(input: Pick<RunHandoffInput, "preflightStatus" | "preflightRisk">): string | null {
  const status = cleanOptionalText(input.preflightStatus);
  const risk = cleanOptionalText(input.preflightRisk);
  if (status && risk) return `${status} / ${risk}`;
  return status ?? (risk ? `risk: ${risk}` : null);
}

export function buildControlledRunPrompt(input: Pick<RunHandoffInput, "task">): string {
  const task = cleanDisplayText(input.task, DEFAULT_TASK, 3000);
  return [
    "You are working under M9R-controlled repo rules.",
    "",
    "Task:",
    task,
    "",
    "Before editing:",
    "1. Pull instructions with the CLI if an M9R dashboard instruction was sent.",
    "2. Load and follow the active M9R repo rules.",
    "3. Keep the change focused to the task.",
    "4. Avoid touching auth, payments, migrations, secrets, deployment, dependencies, or user-data flows unless required by the task.",
    "5. If you must touch a sensitive area, explain why before making the change.",
    "6. Run the most relevant verification command available.",
    "7. At the end, prepare a concise redacted evidence summary with:",
    "   - changed files",
    "   - verification commands run",
    "   - pass/fail result",
    "   - any failed commands",
    "   - anything requiring human review",
    "",
    "Do not claim success without agent evidence for human approval.",
  ].join("\n");
}

export function buildEvidenceTemplate(input: Pick<RunHandoffInput, "task">): string {
  const task = cleanDisplayText(input.task, "", 1000);
  return [
    "Task:",
    task,
    "What changed:",
    "Why these changes were made:",
    "Scope deviations:",
    "Limitations or unresolved issues:",
    "Changed files:",
    "Verification commands:",
    "Results:",
    "Failed commands:",
    "Sensitive areas touched:",
    "Rule conflicts or uncertainty:",
    "Human review notes:",
  ].join("\n");
}

export function buildRunHandoff(input: RunHandoffInput): RunHandoff {
  const runId = cleanDisplayText(input.runId, "unknown run", 120);
  const task = cleanDisplayText(input.task, DEFAULT_TASK, 1000);
  const evidenceState: HandoffEvidenceState = input.hasEvidence ? "submitted" : "waiting";
  const runContract = buildRunContract({
    task,
    preflightStatus: input.preflightStatus,
    preflightRisk: input.preflightRisk,
    activeRuleCount: input.activeRuleCount,
  });
  return {
    identity: {
      runId,
      agent: agentLabel(input),
      task,
      startedAt: cleanOptionalText(input.startedAt),
      preflight: preflightLabel(input),
    },
    rulesCommand: M9R_RULES_COMMAND,
    rulesCommandHelp: RULES_COMMAND_HELP,
    inboxCommand: M9R_INBOX_COMMAND,
    inboxCommandHelp: INBOX_COMMAND_HELP,
    agentPrompt: buildControlledRunPrompt({ task }),
    runContract,
    evidenceTemplate: buildEvidenceTemplate({ task }),
    evidenceState,
    evidenceStatusLabel: evidenceState === "submitted" ? "Approved evidence submitted" : "Waiting for approved evidence",
    passportActionLabel: "View Run Passport",
  };
}
