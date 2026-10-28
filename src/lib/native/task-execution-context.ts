import type { Task } from "./inbox-core";
import { RESULT_RECONCILIATION_MAX_AGE_MS, type LocalStore } from "./local-store";

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
  // Keep the stable signature for adapters while intentionally excluding the
  // values from provider-visible context. Correlation stays in the store.
  void task;
  void handle;
  void identityToken;
  return "M9R assigned one approved work item to this turn. Work only on the message above. When finished or blocked, call m9r_result with the concrete outcome; the connected M9R session supplies internal correlation automatically. Keep routing metadata and credentials out of your reply.";
}

/**
 * Rejoin a visible prompt to a previously approved delivery using trusted
 * session metadata and persisted ownership. No provider name, recency guess,
 * or task text supplied by another session can select a credential.
 */
export function deliveredTaskContext(store: LocalStore, input: { handle: string; provider: string; sessionId?: string; taskId?: string; prompt: string; now?: number }): string | undefined {
  if (!input.sessionId) return undefined;
  const token = store.identityTokenFor(input.handle, input.sessionId);
  const identity = token ? store.verifyIdentity(token) : null;
  if (!token || !identity || identity.provider.toLowerCase() !== input.provider.toLowerCase()) return undefined;
  const at = input.now ?? Date.now();
  const matches = store.tasksForSession(input.handle, input.sessionId).filter(task => {
    const owner = task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId;
    const createdAt = Date.parse(task.createdAt);
    const ageMs = at - createdAt;
    return owner === input.sessionId && (input.taskId ? task.id === input.taskId : task.goal === input.prompt) && !task.resultSummary
      && (task.approval === "approved" || task.approval === "not_needed")
      && Number.isFinite(createdAt) && ageMs >= 0 && ageMs <= RESULT_RECONCILIATION_MAX_AGE_MS
      && (task.delivery?.state === "sending" || task.delivery?.state === "queued" || task.deliverySource === "prompt");
  });
  if (matches.length > 1) return "M9R cannot uniquely bind this delivered prompt to its approved task. Do not dispatch desktop work until the delivery adapter supplies an unambiguous internal task reference.";
  return matches.length === 1 ? renderTaskExecutionContext(matches[0], input.handle, token) : undefined;
}
