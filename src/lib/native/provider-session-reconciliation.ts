import { createLocalStore, type LocalStore, type SessionRecord } from "./local-store";
import type { ConnectionBinding } from "./mcp-connection-core";
import { claudeSessionsDir, readClaudeSessions, type ClaudeSession } from "./claude-registry";
import { realDeps } from "./codex-delivery";
import type { Liveness } from "./codex-liveness";
import { normCwd } from "./codex-delivery-core";

/** OpenCode's managed plugin sends this heartbeat every 1.5 seconds. */
export const OPENCODE_SESSION_HEARTBEAT_TTL_MS = 30_000;

const MAX_CODEX_SESSION_PROBES = 60;

interface LiveSessionObservation {
  provider: string;
  sessionId: string;
  cwd?: string;
  processId?: number;
}

export interface ProviderSessionReconciliationOptions {
  root: string;
  providerId: string;
  /** Primary compatibility selector for an externally opened provider session. */
  expectedCwd?: string;
  /** Restrict reconciliation to a session explicitly identified by the provider host. */
  expectedSessionId?: string;
  /** Restrict recovery to the provider process that launched this MCP connection. */
  expectedProcessId?: number;
  env?: Record<string, string | undefined>;
  nowMs?: () => number;
  store?: LocalStore;
  readClaudeSessions?: () => ClaudeSession[];
  codexSessionLiveness?: (threadIds: string[]) => Promise<Record<string, Liveness>>;
  codexSessionProcessIds?: (threadIds: string[]) => Promise<Record<string, number | undefined>>;
}

function recentOpenCodeSessions(store: LocalStore, nowMs: number): SessionRecord[] {
  return store.sessionsFor("opencode").filter((session) => {
    if (session.provider.toLowerCase() !== "opencode") return false;
    const lastSeen = Date.parse(session.lastSeenAt);
    return Number.isFinite(lastSeen)
      && lastSeen <= nowMs
      && nowMs - lastSeen <= OPENCODE_SESSION_HEARTBEAT_TTL_MS;
  });
}

async function liveSessions(
  providerId: string,
  store: LocalStore,
  options: ProviderSessionReconciliationOptions,
): Promise<{ observations: LiveSessionObservation[]; source: string; error?: string }> {
  if (providerId === "claude-code") {
    const sessions = (options.readClaudeSessions ?? (() => readClaudeSessions(claudeSessionsDir(options.env))))();
    return {
      observations: sessions.map((session) => ({
        provider: "claude-code",
        sessionId: session.sessionId,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        processId: session.pid,
      })),
      source: "Claude's live-session registry",
    };
  }

  if (providerId === "opencode") {
    const sessions = recentOpenCodeSessions(store, (options.nowMs ?? Date.now)());
    return {
      observations: sessions.map((session) => {
        const processId = store.connectionProcessIdForSession({
          provider: "opencode",
          sessionId: session.sessionId,
          ...(session.cwd ? { cwd: session.cwd } : {}),
        });
        return {
          provider: "opencode",
          sessionId: session.sessionId,
          ...(session.cwd ? { cwd: session.cwd } : {}),
          ...(processId !== undefined ? { processId } : {}),
        };
      }),
      source: "OpenCode's recent plugin session heartbeat",
    };
  }

  if (providerId === "codex") {
    const candidates = store.sessionsFor("codex")
      .filter((session) => session.provider.toLowerCase() === "codex")
      .slice(0, MAX_CODEX_SESSION_PROBES);
    const source = "Codex rollout-file liveness and Restart Manager process ownership";
    if (candidates.length === 0) return { observations: [], source };
    const dependencies = realDeps(options.env);
    const check = options.codexSessionLiveness ?? dependencies.sessionLiveness;
    if (!check) return { observations: [], source: "Codex rollout-file liveness", error: "the platform cannot verify open Codex sessions" };
    let liveness: Record<string, Liveness>;
    try {
      liveness = await check(candidates.map((session) => session.sessionId));
    } catch {
      return { observations: [], source, error: "the open-session check failed" };
    }
    const liveSessionIds = candidates.filter((session) => liveness[session.sessionId] === "live").map((session) => session.sessionId);
    const ownerCheck = options.codexSessionProcessIds ?? dependencies.sessionOwnerProcessIds;
    let ownerProcessIds: Record<string, number | undefined> = {};
    if (liveSessionIds.length > 0) {
      if (!ownerCheck) return { observations: [], source, error: "the platform cannot identify the process that owns a live Codex session" };
      try {
        ownerProcessIds = await ownerCheck(liveSessionIds);
      } catch {
        return { observations: [], source, error: "the live-session process-owner check failed" };
      }
    }

    const unresolvedProcessOwnerCount = liveSessionIds.filter((sessionId) => {
      const processId = ownerProcessIds[sessionId];
      return !Number.isSafeInteger(processId) || (processId ?? 0) <= 0;
    }).length;
    const observations = candidates
      .filter((session) => liveness[session.sessionId] === "live")
      .map((session) => ({
        provider: "codex",
        sessionId: session.sessionId,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(Number.isSafeInteger(ownerProcessIds[session.sessionId]) && (ownerProcessIds[session.sessionId] ?? 0) > 0
          ? { processId: ownerProcessIds[session.sessionId]! }
          : {}),
      }));
    const errors = [
      candidates.some((session) => liveness[session.sessionId] !== "live" && liveness[session.sessionId] !== "free")
        ? "one or more Codex sessions could not be verified"
        : undefined,
      unresolvedProcessOwnerCount > 0 ? "one or more live sessions did not have a unique owning process" : undefined,
    ].filter((message): message is string => Boolean(message));
    return {
      observations,
      source,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  }

  return { observations: [], source: "provider live-session observer", error: `no live-session observer is registered for ${providerId}` };
}

/**
 * Rebind only provider sessions proved live by that provider's supported local
 * control surface, then verify that the exact session owns the resulting M9R
 * binding. Executable/config presence alone is never treated as connectivity.
 */
export async function reconcileProviderSessions(
  options: ProviderSessionReconciliationOptions,
): Promise<{ healthy: boolean; detail: string; binding?: ConnectionBinding }> {
  const store = options.store ?? createLocalStore(options.root);
  const observed = await liveSessions(options.providerId, store, options);
  const unique = new Map<string, LiveSessionObservation>();
  for (const session of observed.observations) {
    const key = `${session.sessionId}\0${normCwd(session.cwd)}`;
    unique.set(key, session);
  }
  let sessions = [...unique.values()];
  if (sessions.length === 0) {
    const reason = observed.error ?? `no live ${options.providerId} session was observed`;
    return { healthy: false, detail: `${observed.source}: ${reason}` };
  }

  const expectedSessionId = options.expectedSessionId?.trim();
  const expectedCwd = options.expectedCwd === undefined ? undefined : normCwd(options.expectedCwd);
  if (options.expectedCwd !== undefined && !expectedCwd) {
    return { healthy: false, detail: `${observed.source}: the expected provider project folder is empty; refusing to guess` };
  }
  if (expectedCwd !== undefined) {
    sessions = sessions.filter((session) => normCwd(session.cwd) === expectedCwd);
    if (sessions.length === 0) {
      return { healthy: false, detail: `${observed.source}: no live session matched provider project folder ${expectedCwd}; refusing to guess` };
    }
  }
  const hasExactSelector = Boolean(expectedSessionId) || expectedCwd !== undefined || options.expectedProcessId !== undefined;
  if (hasExactSelector) {
    const providerCandidates = sessions;
    sessions = providerCandidates.filter((session) => {
      if (expectedSessionId && session.sessionId !== expectedSessionId) return false;
      // A process ID and a session ID are separate facts. Never attach an
      // unowned session to the MCP caller merely because its session ID was
      // configured; when both selectors are present, the observer must prove
      // that this provider process owns that exact session.
      if (options.expectedProcessId !== undefined && session.processId !== options.expectedProcessId) return false;
      // A provider's session id is an exact selector when explicitly supplied
      // by that host. Without one, a process-only lookup must be backed by the
      // observer's own process-to-session mapping; provider-wide heartbeats
      // cannot be attributed to whichever MCP child happened to ask.
      return true;
    });

    // A provider process can legitimately own several conversation files. An
    // exact session ID from the provider host scopes the recovery more tightly
    // than sibling liveness/owner warnings, so only the selected session must
    // be live and match the supplied process (when that mapping is available).
    // Process-only recovery has no such disambiguator and remains fail-closed.
    if (observed.error && !expectedSessionId && expectedCwd === undefined) {
      return {
        healthy: false,
        detail: `${observed.source}: exact connection was not rebound because ${observed.error}`,
      };
    }
    if (sessions.length !== 1) {
      const exactSession = expectedSessionId
        ? providerCandidates.find((session) => session.sessionId === expectedSessionId)
        : undefined;
      const exactSessionOwnerUnverified = options.expectedProcessId !== undefined
        && exactSession !== undefined
        && exactSession.processId === undefined;
      const detail = sessions.length === 0
        ? exactSessionOwnerUnverified
          ? "could not verify the owning process for the exact session"
          : options.expectedProcessId !== undefined && !expectedSessionId && providerCandidates.every((session) => session.processId === undefined)
            ? "the live-session observer does not identify the owning process"
          : "no live session matched the exact process/session selector"
        : expectedCwd !== undefined && !expectedSessionId && options.expectedProcessId === undefined
          ? "multiple live sessions match the provider project folder; an explicit session or connection selector is required"
          : "the provider process maps to multiple live sessions; an exact session selector is required";
      return { healthy: false, detail: `${observed.source}: ${detail}; refusing to guess` };
    }
  } else if (options.providerId === "codex") {
    // Without an exact provider-session selector, a live rollout file is not
    // enough to claim it for an MCP connection unless the OS also identified
    // its owning process. Keep unknown-owner sessions visible to exact-session
    // recovery, but never bind them through provider-wide discovery.
    sessions = sessions.filter((session) => session.processId !== undefined);
  }

  let bound = 0;
  let failed = 0;
  let exactBinding: ConnectionBinding | undefined;
  for (const session of sessions) {
    try {
      const binding = store.reconcileLiveProviderConnection({
        ...session,
      });
      const identity = binding ? store.verifyConnectionBinding(binding.bindingId) : null;
      if (identity
        && identity.sessionId === session.sessionId
        && identity.provider.toLowerCase() === session.provider.toLowerCase()) {
        bound += 1;
        if (hasExactSelector && sessions.length === 1 && binding) exactBinding = binding;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  const scopedToExactSelector = Boolean(expectedSessionId || expectedCwd !== undefined);
  const fullyBound = bound === sessions.length && failed === 0 && (scopedToExactSelector || !observed.error);
  const observerNote = observed.error
    ? scopedToExactSelector
      ? `; sibling-session observations were incomplete (${observed.error})`
      : `; ${observed.error}`
    : "";
  return {
    healthy: fullyBound,
    detail: `${observed.source}: rebound and verified ${bound}/${sessions.length} exact live session(s)`
      + (options.expectedProcessId !== undefined ? ` for exact provider process ${options.expectedProcessId}` : "")
      + (expectedSessionId ? ` for exact session ${expectedSessionId}` : "")
      + (expectedCwd !== undefined ? ` for exact provider project folder ${expectedCwd}` : "")
      + observerNote,
    ...(fullyBound && hasExactSelector && sessions.length === 1 && exactBinding ? { binding: exactBinding } : {}),
  };
}
