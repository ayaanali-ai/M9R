/**
 * N5: who counts as a human, when a standing rule may approve on the user's behalf, and when a pending approval lapses.
 * Pure, so the rules are unit tested. The point of all of it: a task an agent started on its own never reaches another
 * agent as a real prompt until a person said so (design section 7).
 */
import type { Task } from "./inbox-core";

/** Environment markers an agent's shell tool carries. A person's own terminal has none of them. */
const AGENT_ENV_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_CI", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE", "OPENCODE_SESSION_ID"] as const;

export function isAgentContext(env: Record<string, string | undefined>): boolean {
  return AGENT_ENV_MARKERS.some((k) => !!env[k]);
}

/**
 * A command counts as typed by a person only with a real terminal and no agent markers. An agent's shell tool has no
 * terminal, so `m9r-cli send` run by an agent is an agent-initiated task. `M9R_SEND_AS_HUMAN=1` is for scripts the user
 * runs themselves (it is the user's own environment, like any other setting).
 */
export function isHumanContext(input: { hasTerminal: boolean; env: Record<string, string | undefined> }): boolean {
  if (input.env.M9R_SEND_AS_HUMAN === "1") return true;
  return input.hasTerminal && !isAgentContext(input.env);
}

/** Goals that always need a fresh yes, even with a standing rule (design section 7: protected actions always ask). */
const PROTECTED: readonly RegExp[] = [
  /\brm\s+-\w*r/i, /\bdel(?:ete)?\b[^.\n]{0,40}\b(?:file|folder|director|branch|database|table|repo|account|bucket)/i,
  /\bforce[- ]push\b|\bpush\b[^.\n]{0,20}--force|\breset\s+--hard\b/i,
  /\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i,
  /\b(?:deploy|publish|release|ship)\b/i, /\bnpm\s+publish\b/i,
  /\b(?:secret|credential|password|api[_ -]?key|private key|token)s?\b/i,
  /\b(?:pay|payment|charge|refund|invoice|transfer|wire)\b/i,
  /\b(?:send|post|email|message)\b[^.\n]{0,30}\b(?:to|on)\b[^.\n]{0,30}\b(?:customer|client|slack|discord|twitter|x\.com|everyone|team)\b/i,
];

export function isProtectedAction(goal: string): boolean {
  return PROTECTED.some((re) => re.test(goal));
}

export interface StandingRule {
  id: string;
  from: string;
  to: string;
  createdAt: string;
  expiresAt: string;
  note?: string;
}

export const MAX_RULE_MS = 24 * 60 * 60_000;
export const DEFAULT_RULE_MS = 60 * 60_000;
export const PENDING_TTL_MS = 24 * 60 * 60_000;

/** "30m", "2h" or "1d"; never longer than a day, so a forgotten rule cannot outlive its purpose. */
export function parseDuration(text: string | undefined): number | null {
  if (!text) return DEFAULT_RULE_MS;
  const m = /^(\d{1,3})\s*(m|h|d)$/i.exec(text.trim());
  if (!m) return null;
  const ms = Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2].toLowerCase() as "m" | "h" | "d"];
  return ms > 0 && ms <= MAX_RULE_MS ? ms : null;
}

/** A rule covers a task only while unexpired, for exactly that sender and target, and never for a protected action. */
export function ruleCovers(rules: readonly StandingRule[], task: { from: string; to: string; goal: string }, now: Date): StandingRule | undefined {
  if (isProtectedAction(task.goal)) return undefined;
  return rules.find((r) => r.from === task.from && r.to === task.to && Date.parse(r.expiresAt) > now.getTime());
}

/** Pending tasks older than the limit lapse instead of waiting forever; an old yes is not assumed. */
export function lapsedPending(tasks: readonly Pick<Task, "id" | "approval" | "createdAt">[], now: Date, ttlMs = PENDING_TTL_MS): string[] {
  return tasks.filter((t) => t.approval === "pending" && now.getTime() - Date.parse(t.createdAt) > ttlMs).map((t) => t.id);
}
