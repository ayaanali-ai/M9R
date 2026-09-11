export const MAX_AGENT_INSTRUCTION_LENGTH = 1000;
export const MAX_AGENT_INBOX_ITEMS = 10;

export type AgentInstructionStatus = "queued" | "pulled";

export interface AgentInboxInstruction {
  id: string;
  instruction: string;
  status: AgentInstructionStatus;
  created_at: string;
  pulled_at: string | null;
}

function redactInstructionSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|oak_[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_-]{6,}|github_pat_[A-Za-z0-9_-]{6,})\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[redacted]");
}

export function sanitizeInstructionText(value: unknown): string {
  if (typeof value !== "string") return "";
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  const withoutTags = withoutControls.replace(/<[^>]*>/g, "");
  const compact = redactInstructionSecrets(withoutTags)
    .replace(/\s+/g, " ")
    .slice(0, MAX_AGENT_INSTRUCTION_LENGTH)
    .trim();
  return redactInstructionSecrets(compact).slice(0, MAX_AGENT_INSTRUCTION_LENGTH).trim();
}

export function agentCanReadInstructions(scopes: readonly string[] | null | undefined): boolean {
  return Boolean(scopes?.includes("instructions:read") || scopes?.includes("rules:read"));
}
