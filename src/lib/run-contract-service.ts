/**
 * Run Contract v1 is a compact, task-scoped packet for a connected coding
 * agent. It describes OathLock's expectations; it does not claim to sandbox,
 * intercept, or force an external agent to comply.
 */
export type RunContractPermissionMode =
  | "Routine build"
  | "Guarded change"
  | "Elevated run"
  | "Blocked";

export interface RunContractInput {
  task: string;
  preflightStatus?: string | null;
  preflightRisk?: string | null;
  activeRuleCount?: number | null;
}

export interface RunContract {
  permissionMode: RunContractPermissionMode;
  activeRuleCount: number;
  verificationExpectation: string;
  scopeExpectation: string;
  summary: string;
  prompt: string;
}

function cleanTask(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000) || "Describe the task here.";
}

function safeRuleCount(value: number | null | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : 0;
}

export function permissionModeForPreflight(status: string | null | undefined): RunContractPermissionMode {
  if (status === "blocked") return "Blocked";
  if (status === "needs_approval") return "Elevated run";
  if (status === "warned") return "Guarded change";
  return "Routine build";
}

export function buildRunContract(input: RunContractInput): RunContract {
  const task = cleanTask(input.task);
  const activeRuleCount = safeRuleCount(input.activeRuleCount);
  const permissionMode = permissionModeForPreflight(input.preflightStatus);
  const risk = typeof input.preflightRisk === "string" && input.preflightRisk.trim()
    ? input.preflightRisk.trim()
    : "unclassified";
  const scopeExpectation = permissionMode === "Elevated run"
    ? "Use only the approved elevated scope; stop and ask before any further exception."
    : permissionMode === "Blocked"
      ? "Do not start this run until a human changes the task or policy context."
      : "Keep work within the named task and request an exception before entering a sensitive area.";
  const verificationExpectation = permissionMode === "Blocked"
    ? "No verification is requested because this run must not start."
    : "Run the most relevant available verification and report pass/fail plus any failed command.";
  const ruleLabel = `${activeRuleCount} active rule${activeRuleCount === 1 ? "" : "s"}`;
  const summary = `${permissionMode}. ${ruleLabel} apply. ${scopeExpectation}`;
  const prompt = [
    "M9R Run Contract v1",
    `Task: ${task}`,
    `Permission mode: ${permissionMode}`,
    `Risk signal: ${risk}`,
    `Rules: ${ruleLabel}`,
    `Scope: ${scopeExpectation}`,
    `Verification: ${verificationExpectation}`,
    "Return: changed files, verification commands, result, blockers, and any permission exception requested.",
    "This is a run contract, not an execution sandbox.",
  ].join("\n");

  return {
    permissionMode,
    activeRuleCount,
    verificationExpectation,
    scopeExpectation,
    summary,
    prompt,
  };
}
