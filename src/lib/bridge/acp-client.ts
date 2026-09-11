import { randomUUID } from "node:crypto";
import { isMissionFeatureEnabled, type MissionFeatureFlagEnvironment } from "@/lib/mission/mission-feature-flags";
import type { ProviderAssignment } from "@/lib/mission/mission-provider-adapter";
import {
  BridgeSessionRegistry,
  type BridgeSessionRecord,
} from "./bridge-session-registry";
import type { AgentServerHandle, AgentSessionHandle, InteractiveProviderAdapter, InteractiveProviderEvent } from "./interactive-provider-adapter";
import { AcpProviderRegistry, createDefaultAcpProviderRegistry } from "./acp-provider-registry";
import type { ProviderAdapterConfig } from "@/lib/provider-adapter-config";

export interface BridgeRuntimeEventSinkInput {
  session: BridgeSessionRecord;
  event: InteractiveProviderEvent;
  executionId: string;
  assignmentId: string | null;
}

export type BridgeRuntimeEventSink = (input: BridgeRuntimeEventSinkInput) => Promise<void>;

export interface AcpSessionStartInput {
  adapter: InteractiveProviderAdapter;
  assignment: ProviderAssignment;
  executionId?: string;
  environment: { workingDirectory: string; kind: import("@/lib/mission/mission-process-host").EnvironmentKind };
  session: Omit<BridgeSessionRecord, "state" | "lastHeartbeatAt" | "unreadDeliveryCount" | "createdAt" | "updatedAt">;
}

export interface AcpSessionControllerOptions {
  /** Maximum provider server/session processes held by one bridge instance. */
  maxActiveSessions?: number;
  /** Maximum automatic provider restarts within the recovery window. */
  maxRecoveryAttempts?: number;
  /** Rolling window used by the bounded restart circuit breaker. */
  recoveryWindowMs?: number;
  /** Backoff delays between restart attempts. */
  recoveryBackoffMs?: readonly number[];
}

interface ActiveAcpSession {
  adapter: InteractiveProviderAdapter;
  server: AgentServerHandle;
  providerSession: AgentSessionHandle;
  executionId: string;
  assignmentId: string | null;
  assignment: ProviderAssignment;
  environment: AcpSessionStartInput["environment"];
  recoveryAttempts: number[];
  recoveryPromise: Promise<boolean> | null;
}

export class AcpSessionController {
  private readonly sessions = new Map<string, ActiveAcpSession>();
  private readonly registry: BridgeSessionRegistry;
  private readonly env: MissionFeatureFlagEnvironment;
  private readonly providerRegistry: AcpProviderRegistry;
  private readonly runtimeEventSink?: BridgeRuntimeEventSink;
  private readonly maxActiveSessions: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryWindowMs: number;
  private readonly recoveryBackoffMs: readonly number[];

  constructor(registry: BridgeSessionRegistry, env: MissionFeatureFlagEnvironment = process.env, providerRegistry = new AcpProviderRegistry(), runtimeEventSink?: BridgeRuntimeEventSink, options: AcpSessionControllerOptions = {}) {
    this.registry = registry;
    this.env = env;
    this.providerRegistry = providerRegistry;
    this.runtimeEventSink = runtimeEventSink;
    this.maxActiveSessions = Math.max(1, Math.min(options.maxActiveSessions ?? 32, 128));
    this.maxRecoveryAttempts = Math.max(1, Math.min(options.maxRecoveryAttempts ?? 3, 8));
    this.recoveryWindowMs = Math.max(1_000, options.recoveryWindowMs ?? 60_000);
    this.recoveryBackoffMs = options.recoveryBackoffMs?.length ? options.recoveryBackoffMs.map((delay) => Math.max(0, delay)) : [250, 1_000, 3_000];
  }

  async start(input: AcpSessionStartInput): Promise<{ ok: true; session: BridgeSessionRecord } | { ok: false; reason: string }> {
    if (!isMissionFeatureEnabled("acpBridge", this.env)) return { ok: false, reason: "acp_bridge_disabled" };
    if (this.registry.get(input.session.sessionId)) return { ok: false, reason: "session_already_registered" };
    if (this.sessions.size >= this.maxActiveSessions) return { ok: false, reason: "provider_session_pool_exhausted" };
    const server = await input.adapter.launchServer({ assignment: input.assignment, environment: input.environment });
    try {
      const initialized = await input.adapter.initialize(server);
      if (initialized.capabilities.interactive_session !== true) {
        return { ok: false, reason: "interactive_session_unsupported" };
      }
      const providerSession = await input.adapter.createSession({ server, assignment: input.assignment, executionId: input.executionId ?? input.session.sessionId });
      let session = this.registry.register({ ...input.session, providerSessionRef: providerSession.providerSessionRef, capabilities: initialized.capabilities, availableModels: providerSession.availableModels ?? null });
      const launching = this.registry.transition(session.sessionId, "launching");
      if (!launching.ok) return launching;
      session = launching.session;
      const initializing = this.registry.transition(session.sessionId, "initializing");
      if (!initializing.ok) return initializing;
      session = initializing.session;
      const ready = this.registry.transition(session.sessionId, "ready");
      if (!ready.ok) return ready;
      this.sessions.set(session.sessionId, {
        adapter: input.adapter,
        server,
        providerSession,
        executionId: input.executionId ?? session.sessionId,
        assignmentId: input.assignment.assignmentId ?? null,
        assignment: input.assignment,
        environment: input.environment,
        recoveryAttempts: [],
        recoveryPromise: null,
      });
      return ready;
    } finally {
      if (!this.sessions.has(input.session.sessionId)) await input.adapter.shutdown(server).catch(() => undefined);
    }
  }

  async startRegistered(input: Omit<AcpSessionStartInput, "adapter"> & { adapterId: string }): Promise<{ ok: true; session: BridgeSessionRecord } | { ok: false; reason: string }> {
    const adapter = this.providerRegistry.get(input.adapterId);
    if (!adapter) return { ok: false, reason: "provider_adapter_unavailable" };
    return this.start({ ...input, adapter });
  }

  async *prompt(sessionId: string, text: string): AsyncIterable<InteractiveProviderEvent> {
    const current = this.registry.get(sessionId);
    let controller = this.sessions.get(sessionId);
    if (!current || !controller) throw new Error("Bridge session is not active.");
    try {
      await this.ensureHealthy(sessionId, controller);
      controller = this.sessions.get(sessionId) ?? controller;
    } catch (error) {
      yield this.failureEvent(sessionId, error);
      return;
    }
    const latest = this.registry.get(sessionId) ?? current;
    if (latest.state === "ready" || latest.state === "waiting") this.registry.transition(sessionId, "working");
    const turnId = `turn-${randomUUID()}`;
    try {
      for await (const event of controller.adapter.prompt({ session: controller.providerSession, text })) {
        const turnEvent = event.turnId ? event : { ...event, turnId };
        this.publishRuntimeEvent(sessionId, controller, turnEvent);
        yield turnEvent;
        if (event.type === "provider.failed" && controller.adapter.getServerHealth?.(controller.server).state === "dead") {
          await this.recoverSession(sessionId, controller);
        }
      }
    } catch (error) {
      if (controller.adapter.getServerHealth?.(controller.server).state === "dead") {
        await this.recoverSession(sessionId, controller);
      }
      yield this.failureEvent(sessionId, error, turnId);
    } finally {
      const finalState = this.registry.get(sessionId);
      if (finalState?.state === "working" || finalState?.state === "waiting") this.registry.transition(sessionId, "ready");
    }
  }

  /** Delivers a human's decision to the exact session that's actually waiting on it -- the one call that turns a stored bridge_permission_requests decision (bridge-permission-service.ts) into the adapter's own requestPermission promise resolving, instead of that promise just sitting until its 15-minute timeout. */
  async respondToPermission(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const controller = this.sessions.get(sessionId);
    if (!controller) throw new Error(`Bridge session ${sessionId} is not active.`);
    await controller.adapter.respondToPermission({ session: controller.providerSession, requestId, approved });
  }

  /**
   * The human-interrupt control. The underlying adapter method
   * (acp-stdio-adapter.ts's cancelTurn, wired to a real ACP `cancel()` RPC)
   * already existed with zero caller anywhere in this codebase -- this is
   * the missing seam that lets bridge-runtime.ts (and eventually a UI Stop
   * button) actually reach it, same shape as respondToPermission above.
   * Throws if the session isn't active rather than silently no-opping, so a
   * caller can tell "there was nothing to cancel" from "the cancel failed".
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const controller = this.sessions.get(sessionId);
    if (!controller) throw new Error(`Bridge session ${sessionId} is not active.`);
    await controller.adapter.cancelTurn({ session: controller.providerSession });
  }

  listSessions(): BridgeSessionRecord[] {
    return [...this.registry.list()];
  }

  async close(sessionId: string): Promise<void> {
    const controller = this.sessions.get(sessionId);
    if (!controller) return;
    // Neither adapter call takes an AbortSignal, and a dead-but-not-exited
    // provider process (the same failure mode that used to wedge a live
    // turn forever, see withStallTimeout in bridge-runtime.ts) can leave
    // these unresolved -- which used to hang the whole bridge's shutdown,
    // since callers await close() per session in a loop. Bounding each call
    // here lets shutdown always finish; a timed-out close still marks the
    // session closed and removes it from `this.sessions` below, same as a
    // clean close would.
    const CLOSE_STEP_TIMEOUT_MS = 10_000;
    const withTimeout = (label: string, promise: Promise<unknown>): Promise<void> =>
      Promise.race([
        promise.then(() => undefined),
        new Promise<void>((resolve) => { const t = setTimeout(() => { console.error(`[acp-client] ${label} for session ${sessionId} did not finish within ${CLOSE_STEP_TIMEOUT_MS}ms -- abandoning it and continuing shutdown.`); resolve(); }, CLOSE_STEP_TIMEOUT_MS); t.unref?.(); }),
      ]);
    await withTimeout("closeSession", controller.adapter.closeSession({ session: controller.providerSession }).catch((error) => { console.error(`[acp-client] closeSession failed for session ${sessionId}:`, error instanceof Error ? error.message : error); }));
    await withTimeout("shutdown", controller.adapter.shutdown(controller.server).catch((error) => { console.error(`[acp-client] shutdown failed for session ${sessionId}:`, error instanceof Error ? error.message : error); }));
    this.registry.transition(sessionId, "closed");
    this.sessions.delete(sessionId);
  }

  private publishRuntimeEvent(sessionId: string, controller: ActiveAcpSession, event: InteractiveProviderEvent): void {
    if (!this.runtimeEventSink) return;
    try {
      const session = this.registry.get(sessionId);
      if (!session) return;
      // Runtime fan-out is observability, not the provider's response path.
      void this.runtimeEventSink({ session, event, executionId: controller.executionId, assignmentId: controller.assignmentId }).catch((error) => {
        console.error("Bridge runtime event sink failed.", error instanceof Error ? error.message : error);
      });
    } catch (error) {
      console.error("Bridge runtime event sink failed.", error instanceof Error ? error.message : error);
    }
  }

  private failureEvent(sessionId: string, error: unknown, turnId?: string): InteractiveProviderEvent {
    return {
      type: "provider.failed",
      sessionId,
      occurredAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
      payload: { reason: error instanceof Error ? error.message.slice(0, 1_024) : String(error).slice(0, 1_024) },
    };
  }

  private async ensureHealthy(sessionId: string, controller: ActiveAcpSession): Promise<void> {
    const health = controller.adapter.getServerHealth?.(controller.server);
    if (!health || health.state === "alive" || health.state === "unknown") return;
    const recovered = await this.recoverSession(sessionId, controller);
    if (!recovered) throw new Error(`Provider session is unavailable and automatic recovery is circuit-broken: ${health.detail}`);
  }

  private recoverSession(sessionId: string, controller: ActiveAcpSession): Promise<boolean> {
    if (controller.recoveryPromise) return controller.recoveryPromise;
    const recovery = this.recoverSessionInternal(sessionId, controller).finally(() => {
      if (this.sessions.get(sessionId) === controller) controller.recoveryPromise = null;
    });
    controller.recoveryPromise = recovery;
    return recovery;
  }

  private async recoverSessionInternal(sessionId: string, controller: ActiveAcpSession): Promise<boolean> {
    const now = Date.now();
    controller.recoveryAttempts = controller.recoveryAttempts.filter((attempt) => now - attempt < this.recoveryWindowMs);
    if (controller.recoveryAttempts.length >= this.maxRecoveryAttempts) {
      const current = this.registry.get(sessionId);
      if (current && current.state !== "closed" && current.state !== "interrupted") this.registry.transition(sessionId, "interrupted");
      return false;
    }
    controller.recoveryAttempts.push(now);
    const current = this.registry.get(sessionId);
    if (current && current.state !== "closed" && current.state !== "interrupted") this.registry.transition(sessionId, "interrupted");

    try {
      await controller.adapter.shutdown(controller.server).catch(() => undefined);
      const delay = this.recoveryBackoffMs[Math.min(controller.recoveryAttempts.length - 1, this.recoveryBackoffMs.length - 1)] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const server = await controller.adapter.launchServer({ assignment: controller.assignment, environment: controller.environment });
      try {
        const initialized = await controller.adapter.initialize(server);
        if (initialized.capabilities.interactive_session !== true) throw new Error("Provider restart does not support interactive sessions.");
        let providerSession: AgentSessionHandle;
        try {
          providerSession = controller.providerSession.providerSessionRef
            ? await controller.adapter.resumeSession({ server, providerSessionRef: controller.providerSession.providerSessionRef, assignment: controller.assignment })
            : await controller.adapter.createSession({ server, assignment: controller.assignment, executionId: controller.executionId });
        } catch (resumeError) {
          providerSession = await controller.adapter.createSession({ server, assignment: controller.assignment, executionId: controller.executionId });
          console.warn("Provider session resume failed; created a fresh session after bounded recovery.", resumeError instanceof Error ? resumeError.message : resumeError);
        }
        const nextController: ActiveAcpSession = {
          ...controller,
          server,
          providerSession,
          recoveryAttempts: controller.recoveryAttempts,
          recoveryPromise: null,
        };
        this.sessions.set(sessionId, nextController);
        this.registry.updateProviderSession(sessionId, { providerSessionRef: providerSession.providerSessionRef, capabilities: initialized.capabilities });
        const resuming = this.registry.get(sessionId);
        if (resuming?.state === "interrupted") this.registry.transition(sessionId, "resuming");
        if (this.registry.get(sessionId)?.state === "resuming") this.registry.transition(sessionId, "ready");
        return true;
      } catch (error) {
        await controller.adapter.shutdown(server).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      console.error(`[bridge] provider recovery attempt ${controller.recoveryAttempts.length} failed for ${sessionId}:`, error instanceof Error ? error.message : error);
      return false;
    }
  }
}

/** Default local Bridge composition with an optional generic provider adapter. */
export function createDefaultAcpSessionController(
  env: MissionFeatureFlagEnvironment = process.env,
  runtimeEventSink?: BridgeRuntimeEventSink,
  genericProvider?: ProviderAdapterConfig,
): AcpSessionController {
  return new AcpSessionController(new BridgeSessionRegistry(), env, createDefaultAcpProviderRegistry(genericProvider), runtimeEventSink);
}
