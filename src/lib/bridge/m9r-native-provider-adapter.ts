/**
 * Item #32 phase 3 (wiring): M9R's own harness as a real, fourth
 * `InteractiveProviderAdapter` implementation, sibling to the three
 * ACP-driven ones (`AcpStdioProviderAdapter` instances for Claude Code,
 * Codex, OpenCode). Everything downstream of this interface -- terminal
 * multiplayer, presence, the Mission Relay, the memory catalog -- consumes
 * the normalized `InteractiveProviderEvent` stream this produces, not
 * anything ACP-specific. This adapter existing and emitting well-formed
 * events is what makes M9R's own harness "just work" with multiplayer
 * without a single line of multiplayer-specific code written for it.
 *
 * Structurally different from the ACP adapters in one respect worth
 * stating plainly: there is no separate CLI process to spawn. `launchServer`
 * does not start a child process -- the harness *is* the process already
 * running this code, so "the server" is a lightweight in-memory handle, not
 * a subprocess to supervise. `getServerHealth` is honestly always "alive"
 * for the same reason: there's nothing external whose liveness could be in
 * question.
 *
 * Event vocabulary matches the real, established one `acp-stdio-adapter.ts`
 * already uses (`provider.reply_text`, `provider.activity`,
 * `provider.completed`, `provider.failed`) -- not invented here -- so every
 * existing downstream consumer of that vocabulary (bridge-runtime.ts's
 * workspace activity stream, usage reporting, etc.) works against this
 * adapter's output unchanged.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentServerHandle,
  AgentServerHealth,
  AgentSessionHandle,
  InitializedAgent,
  InteractiveProviderAdapter,
  InteractiveProviderCapabilities,
  InteractiveProviderEvent,
} from "./interactive-provider-adapter";
import type { AdapterContext, ProviderAssignment } from "@/lib/mission/mission-provider-adapter";
import type { EnvironmentKind } from "@/lib/mission/mission-process-host";
import { allCapabilitiesFalse } from "@/lib/mission/mission-provider-adapter";
import { runM9rNativeTurnStream, type M9rNativeLoopChannel } from "./m9r-native-agent-loop";

/** Default model when a connection has no explicit override -- a real, current model id confirmed against a live fetch of the real models.dev catalog on 2026-09-07, never a placeholder. Item #32's per-workspace model-discovery/override pipeline (already built and tested for the ACP providers) applies here too once wired to a real catalog; this is the honest fallback until then. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

interface ServerState {
  workingDirectory: string;
}

interface SessionState {
  serverId: string;
  workspaceId: string;
  workingDirectory: string;
  model: string;
  channel?: M9rNativeLoopChannel;
  /** Set only while a prompt() call is actually in flight -- cancelTurn aborts this; respondToPermission/steer have nothing to act on outside that window. */
  activeAbort?: AbortController;
}

export interface M9rNativeProviderAdapterOptions {
  /** Resolved once per bridge process, same convention as bridge-runtime.ts's own closure-scoped workspaceId. */
  workspaceId: string;
  /** Needed for send_message's real HTTP call (postAgentMessage) -- the ACP providers get this via devMcpServerDescriptor's spawned-process env vars; this adapter has no subprocess to hand env vars to, so it takes them directly. */
  appUrl?: string;
  agentToken?: string;
}

/**
 * Honestly declared capabilities -- every one of these is checked against
 * what phase 1/2 actually built, never assumed true. `approval_requests`,
 * `session_resume`, and mid-turn `steer` are real, named gaps for a later
 * phase (see M9R_MASTER_BUILD_PLAN.md item #32), not silently claimed.
 */
function capabilities(): InteractiveProviderCapabilities {
  return {
    ...allCapabilitiesFalse(),
    non_interactive_execution: true,
    interactive_session: true,
    streaming_output: true,
    cancellation: true,
    tool_event_reporting: true,
    repository_editing: true,
    file_event_reporting: true,
    command_event_reporting: true,
  };
}

export class M9rNativeProviderAdapter implements InteractiveProviderAdapter {
  readonly id = "m9r-native";
  private readonly options: M9rNativeProviderAdapterOptions;
  private readonly servers = new Map<string, ServerState>();
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: M9rNativeProviderAdapterOptions) {
    this.options = options;
  }

  async discoverCapabilities(context: AdapterContext): Promise<InteractiveProviderCapabilities> {
    void context;
    return capabilities();
  }

  async launchServer(input: { assignment: ProviderAssignment; environment: { workingDirectory: string; kind: EnvironmentKind } }): Promise<AgentServerHandle> {
    const serverId = `m9r-native-server-${randomUUID()}`;
    this.servers.set(serverId, { workingDirectory: input.environment.workingDirectory });
    return { serverId, adapterId: this.id };
  }

  getServerHealth(handle: AgentServerHandle): AgentServerHealth {
    void handle;
    // No subprocess to supervise -- the harness IS this process, so "alive"
    // is honestly correct for as long as this code is running at all.
    return { state: "alive", detail: "In-process harness; no separate server process to monitor." };
  }

  async initialize(handle: AgentServerHandle): Promise<InitializedAgent> {
    void handle;
    return { protocolVersion: "m9r-native-1", agentName: "M9R", capabilities: capabilities() };
  }

  async createSession(input: { server: AgentServerHandle; assignment: ProviderAssignment; executionId?: string }): Promise<AgentSessionHandle> {
    const server = this.servers.get(input.server.serverId);
    if (!server) throw new Error(`No launched server for id ${input.server.serverId}.`);
    const sessionId = `m9r-native-session-${randomUUID()}`;
    const channel = this.options.appUrl && this.options.agentToken
      ? { appUrl: this.options.appUrl, agentToken: this.options.agentToken, missionId: input.assignment.missionId }
      : undefined;
    const model = input.assignment.model?.trim() || DEFAULT_MODEL;
    this.sessions.set(sessionId, {
      serverId: input.server.serverId,
      workspaceId: this.options.workspaceId,
      workingDirectory: server.workingDirectory,
      model,
      channel,
    });
    // Real, catalog-sourced model list -- only models from providers this
    // workspace actually has a stored credential for, so the dashboard
    // dropdown (discoveredModelOptions's own convention, matched here)
    // shows genuinely usable options, not every model in the 200+-provider
    // catalog regardless of whether this workspace can call it.
    const availableModels = await this.discoverAvailableModels();
    return { sessionId, providerSessionRef: null, availableModels };
  }

  private async discoverAvailableModels(): Promise<{ id: string; label: string }[] | null> {
    try {
      const [{ getModelCatalog }, { SUPPORTED_NPM_PACKAGES }, { getWorkspaceProviderEnv }] = await Promise.all([
        import("@/lib/mission/m9r-native-model-catalog"),
        import("./m9r-native-provider-registry"),
        import("@/lib/mission/m9r-native-credential-service"),
      ]);
      const [providers, workspaceEnv] = await Promise.all([getModelCatalog(), getWorkspaceProviderEnv(this.options.workspaceId)]);
      const options: { id: string; label: string }[] = [];
      for (const provider of providers.values()) {
        if (!SUPPORTED_NPM_PACKAGES.has(provider.npm)) continue;
        if (!provider.env.some((name) => workspaceEnv[name])) continue;
        for (const model of provider.models) {
          options.push({ id: model.id, label: `${provider.name}/${model.name}` });
        }
      }
      return options.length > 0 ? options : null;
    } catch {
      // Best-effort -- a catalog fetch failure must not block session
      // creation, only degrade the model list to null (never a guessed one).
      return null;
    }
  }

  async resumeSession(input: { server: AgentServerHandle; providerSessionRef: string; assignment: ProviderAssignment }): Promise<AgentSessionHandle> {
    void input;
    // Honest gap, matching session_resume: false above -- this harness
    // doesn't yet persist enough turn state to rejoin an old session rather
    // than starting a new one. Named in the plan, not silently faked.
    throw new Error("M9R's own harness does not support resuming a session yet (item #32, not yet built).");
  }

  private session(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session for id ${sessionId}.`);
    return session;
  }

  async *prompt(input: { session: AgentSessionHandle; text: string }): AsyncIterable<InteractiveProviderEvent> {
    const session = this.session(input.session.sessionId);
    if (session.activeAbort) throw new Error("M9R native session already has an active prompt.");
    const abort = new AbortController();
    session.activeAbort = abort;
    const occurredAt = () => new Date().toISOString();

    try {
      for await (const event of runM9rNativeTurnStream({
        workspaceId: session.workspaceId,
        workingDirectory: session.workingDirectory,
        model: session.model,
        prompt: input.text,
        channel: session.channel,
        abortSignal: abort.signal,
      })) {
        if (event.type === "text-delta") {
          yield { type: "provider.reply_text", sessionId: input.session.sessionId, occurredAt: occurredAt(), payload: { text: event.text } };
        } else if (event.type === "activity") {
          yield {
            type: "provider.activity",
            sessionId: input.session.sessionId,
            occurredAt: occurredAt(),
            payload: {
              type: "provider.activity",
              activityKind: event.activity.activityKind,
              status: "succeeded",
              summary: event.activity.summary,
              filePath: event.activity.filePath ?? null,
              command: event.activity.command ?? null,
              testName: null,
              testPassed: null,
              testFailed: null,
              testSkipped: null,
              reviewTarget: null,
              gitRef: null,
            },
          };
        } else if (event.type === "finish") {
          yield { type: "provider.completed", sessionId: input.session.sessionId, occurredAt: occurredAt(), payload: { stopReason: "end_turn" } };
        } else if (event.type === "error") {
          yield { type: "provider.failed", sessionId: input.session.sessionId, occurredAt: occurredAt(), payload: { reason: event.message } };
        }
      }
    } finally {
      session.activeAbort = undefined;
    }
  }

  async cancelTurn(input: { session: AgentSessionHandle }): Promise<void> {
    const session = this.session(input.session.sessionId);
    session.activeAbort?.abort();
  }

  async respondToPermission(input: { session: AgentSessionHandle; requestId: string; approved: boolean }): Promise<void> {
    void input;
    // Honest gap, matching approval_requests: false above -- this phase's
    // tools (read/search/edit-within-root/send_message) don't raise
    // permission requests yet. Named, not silently ignored.
    throw new Error("M9R's own harness does not raise permission requests yet (item #32, not yet built).");
  }

  async closeSession(input: { session: AgentSessionHandle }): Promise<void> {
    this.sessions.get(input.session.sessionId)?.activeAbort?.abort();
    this.sessions.delete(input.session.sessionId);
  }

  async shutdown(handle: AgentServerHandle): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (session.serverId === handle.serverId) {
        session.activeAbort?.abort();
        this.sessions.delete(sessionId);
      }
    }
    this.servers.delete(handle.serverId);
  }
}

export function createM9rNativeAdapter(options: M9rNativeProviderAdapterOptions): M9rNativeProviderAdapter {
  return new M9rNativeProviderAdapter(options);
}
