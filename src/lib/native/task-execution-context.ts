import type { Task } from "./inbox-core";
import type { LocalStore } from "./local-store";
import { renderSessionCard } from "./inbox-core";

/** Internal correlation belongs in the provider context channel, not task text. */
export const taskCorrelationMarker = (taskId: string) => `[M9R ${taskId}]`;
export const visibleTaskText = (task: Pick<Task, "goal">) => task.goal;

/** Normalize session metadata supplied by connection adapters, never prompt text. */
export function resolveHookSessionMetadata(store: LocalStore, provider: string, handle: string,
  input: { session_id?: string; canonical_session_id?: string; transcript_path?: string }) {
  const declared = input.canonical_session_id;
  if (declared && declared.length <= 256 && !/[\u0000-\u001f\u007f]/.test(declared)) {
    return { sessionId: declared, verified: true };
  }
  const transcriptSession = input.transcript_path?.replaceAll("\\", "/").split("/").at(-1)?.replace(/\.jsonl$/, "");
  if (transcriptSession && store.identityTokenFor(handle, transcriptSession)) return { sessionId: transcriptSession, verified: true };
  const sessionId = input.session_id;
  if (sessionId && store.identityTokenFor(handle, sessionId)) return { sessionId, verified: true };
  // This adapter consumes Codex's native UUID thread field. Other adapters can
  // supply canonical_session_id for arbitrary protocol identifiers. The core
  // identity and computer-use behavior remains common to every provider.
  const verified = provider.toLowerCase() === "codex" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId ?? "");
  return { sessionId, verified };
}

export function renderTaskExecutionContext(task: Pick<Task, "id">, handle: string, identityToken: string): string {
  return `${taskCorrelationMarker(task.id)}\n${renderSessionCard({ handle, others: [], pendingCount: 0, awaitingApproval: 0, identityToken })}\nThis internal reference binds the approved task in the user message. Record its actual outcome through M9R; keep internal identifiers and credentials out of replies.`;
}

/**
 * Rejoin a visible prompt to a previously approved delivery using trusted
 * session metadata and persisted ownership. No provider name, recency guess,
 * or task text supplied by another session can select a credential.
 */
export function deliveredTaskContext(store: LocalStore, input: { handle: string; provider: string; sessionId?: string; taskId?: string; prompt: string }): string | undefined {
  if (!input.sessionId) return undefined;
  const token = store.identityTokenFor(input.handle, input.sessionId);
  const identity = token ? store.verifyIdentity(token) : null;
  if (!token || !identity || identity.provider.toLowerCase() !== input.provider.toLowerCase()) return undefined;
  const matches = store.tasksForSession(input.handle, input.sessionId).filter(task => {
    const owner = task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId;
    return owner === input.sessionId && (input.taskId ? task.id === input.taskId : task.goal === input.prompt) && !task.resultSummary
      && (task.approval === "approved" || task.approval === "not_needed")
      && (task.delivery?.state === "sending" || task.delivery?.state === "queued");
  });
  if (matches.length > 1) return "M9R cannot uniquely bind this delivered prompt to its approved task. Do not dispatch desktop work until the delivery adapter supplies an unambiguous internal task reference.";
  return matches.length === 1 ? renderTaskExecutionContext(matches[0], input.handle, token) : undefined;
}
