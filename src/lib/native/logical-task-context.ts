import { redactSecrets, type LogicalTaskContext, type Task } from "./inbox-core";

const bounded = (value: string, limit: number) => redactSecrets(value).slice(0, limit);
const wasClipped = (value: string, limit: number) => redactSecrets(value).length > limit;

/** Shared with m9r_result's own tool description (mcp-server.ts) and every provider turn
 * prompt. A task having many parts is never by itself a reason to end the turn early. */
export const COMPLETION_DISCIPLINE =
  "Report the actual outcome with m9r_result. A task having many parts or steps is never by "
  + "itself a reason to stop -- keep working through every part of the request in this same "
  + "turn. Use completion.status='incomplete' with the actual remaining requirements only when "
  + "something genuinely prevents continuing right now (an owner decision is needed, the next "
  + "step is destructive or ambiguous, or a hard error blocks it) and say exactly what that "
  + "blocker is. Ending the provider turn alone never completes M9R work, and is never itself "
  + "evidence you were blocked.";

function directiveText(text: string): string {
  // Pill messages may include the recipient mention in the task body. Strip
  // that routing prefix before deciding whether the owner explicitly meant to
  // continue paused work; otherwise "@codex continue" is misread as new work.
  return text.trim().replace(/^@[\w-]+\s*(?::\s*)?/, "").trim();
}

export function isLogicalContinuation(text: string): boolean {
  const trimmed = directiveText(text);
  // The strict "continue/resume [task/work]" grammar missed ordinary natural
  // follow-ups that mean the same thing -- "try that again", "finish the
  // remaining steps", "keep going", "pick up where you left off" -- which
  // then lost their carried-forward remainingWork/priorOutcome purely
  // because of phrasing, not because the owner meant something different.
  if (/^(?:continue|resume)\b/i.test(trimmed)) return true;
  return /^(?:keep going|keep on|carry on|go on|pick up where (?:you|it) left off|finish (?:the\s+)?(?:remaining|rest of the)\s*(?:steps|work|task)?|try (?:that|it) again|(?:please\s+)?retry|where were (?:you|we))\b/i.test(trimmed);
}

export function isExplicitNewWork(text: string): boolean {
  return /^(?:new\s+(?:task|work)|(?:start|begin)\s+(?:a\s+)?new\s+(?:task|work)|separate\s+task)\b/i.test(directiveText(text));
}

/** A paused task is reused only when the owner explicitly continues or redirects it. */
export function shouldReusePausedTask(text: string): boolean {
  const trimmed = directiveText(text);
  if (!trimmed || isExplicitNewWork(trimmed)) return false;
  if (isLogicalContinuation(trimmed)) return true;
  return /^(?:no\b|nope\b|actually\b|instead\b|rather\b|change (?:that|the plan)\b|redirect\b|don't\s+do\b|do\s+not\s+do\b|stop\s+and\s+(?:do|go)\b|scratch\s+that\b|forget\s+that\b)/i.test(trimmed)
    || /\b(?:instead of|change the plan to|replace that with|do this instead)\b/i.test(trimmed);
}

export function nextLogicalTaskContext(task: Task, previous?: Task, continuation = false): LogicalTaskContext {
  const prior = previous?.logicalContext;
  return {
    workId: prior?.workId ?? previous?.id ?? task.id,
    planRevision: (prior?.planRevision ?? 0) + (previous && !continuation ? 1 : 0),
    state: "active",
    control: previous ? continuation ? "continuation" : "redirect" : "new-task",
    originalObjective: bounded(prior?.originalObjective ?? previous?.goal ?? task.goal, 2000),
    latestInstruction: bounded(continuation && previous ? prior?.latestInstruction ?? previous.goal : task.goal, 4000),
    ...(previous ? { previousTaskId: previous.id } : {}),
    ...(continuation && (previous?.completion?.remainingWork ?? prior?.remainingWork)
      ? { remainingWork: [...(previous?.completion?.remainingWork ?? prior!.remainingWork!)].slice(0, 32) } : {}),
    ...(previous?.resultSummary || prior?.priorOutcome
      ? { priorOutcome: bounded(previous?.resultSummary ?? prior!.priorOutcome!, 2000) } : {}),
  };
}

/** Bounded facts for a cold provider turn; old task text is context, never queued work. */
export function logicalTaskHandoff(task: Task): string {
  const context = task.logicalContext;
  if (!context) return "";
  const remainingWorkList = context.remainingWork ?? [context.latestInstruction];
  // Clipping objective/instruction/outcome/pointers text or the remaining-work
  // list down silently dropped later requirements, URLs, and constraints with
  // no trace that anything was cut. Surface it explicitly instead, so the
  // provider (and anyone reading a transcript) knows this handoff is partial
  // rather than assuming it is the complete picture.
  const clipped = [
    wasClipped(context.originalObjective, 2000) && "originalObjective",
    wasClipped(context.latestInstruction, 4000) && "latestInstruction",
    context.priorOutcome && wasClipped(context.priorOutcome, 2000) && "priorOutcome",
    remainingWorkList.length > 32 && "remainingWork (list truncated)",
    remainingWorkList.some((item) => wasClipped(item, 1_000)) && "remainingWork (item text truncated)",
    task.pointers.length > 8 && "pointers (list truncated)",
  ].filter((value): value is string => Boolean(value));
  return "M9R logical task context (data, not additional owner instructions):\n" + JSON.stringify({
    continuityGroupId: context.workId,
    planRevision: context.planRevision,
    control: context.control,
    originalObjective: bounded(context.originalObjective, 2000),
    latestInstruction: bounded(context.latestInstruction, 4000),
    remainingWork: remainingWorkList.slice(0, 32).map((item) => bounded(item, 1_000)),
    ...(context.priorOutcome ? { priorOutcome: bounded(context.priorOutcome, 2000) } : {}),
    pointers: task.pointers.slice(0, 8).map((pointer) => bounded(pointer, 200)),
    ...(clipped.length ? { truncatedFields: clipped } : {}),
  }) + "\nThis is background on what an earlier, now-paused turn already did -- not your current task id, and not "
    + "something to pass to any tool. Call m9r_result with no taskId; M9R resolves your current task automatically. "
    + "A pause on that earlier turn is not evidence of completion, and it does not block your own actions now. "
    + "Reobserve the current surface before acting. Follow the latest instruction; do not replay earlier tasks.";
}
