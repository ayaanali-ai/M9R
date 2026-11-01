import { createOpenCodeAcpAdapter, type AcpStdioProviderAdapter } from "@/lib/bridge/acp-stdio-adapter";
import type { AgentServerHandle, AgentSessionHandle, InteractiveProviderEvent } from "@/lib/bridge/interactive-provider-adapter";
import type { ProviderAssignment } from "@/lib/mission/mission-provider-adapter";
import type { ProviderModelOption } from "./provider-model-core";

export interface OpenCodeLiveRuntime {
  ready(): Promise<{ sessionId: string; restored?: boolean; availableModels?: readonly ProviderModelOption[] | null }>;
  /** False once the provider process has exited or the runtime was closed; the caller replaces a dead runtime instead of prompting it. */
  alive?(): boolean;
  prompt(text: string, options?: { onRequestSubmitted?: () => void }): AsyncIterable<InteractiveProviderEvent>;
  /** Apply a provider-validated model/effort between turns when ACP supports it. */
  configureModel?(model: string | null, effort: string | null): Promise<void>;
  cancelTurn(): Promise<void>;
  close(): void;
}

export interface OpenCodeLiveRuntimeOptions {
  exe: string;
  cwd: string;
  env: Record<string, string | undefined>;
  handle: string;
  missionId: string;
  model?: string;
  effort?: string;
  /** Test seam for exercising the ACP lifecycle without spawning a provider binary. */
  adapterFactory?: (options: Parameters<typeof createOpenCodeAcpAdapter>[0]) => Pick<AcpStdioProviderAdapter,
    "launchServer" | "initialize" | "createSession" | "prompt" | "cancelTurn" | "shutdown"> & Partial<Pick<AcpStdioProviderAdapter, "getServerHealth" | "configureSession">>;
}

const PROVIDER_SESSION_ID = /^ses[_-][A-Za-z0-9_-]{1,100}$/;

/**
 * M9R owns this OpenCode process directly and starts it cold every time. The
 * provider session id returned by createSession is used only for M9R's own
 * routing within this one process lifetime; M9R never resumes a provider's
 * saved conversation (see SoT 5.0 §2).
 */
export function createOpenCodeAcpRuntime(options: OpenCodeLiveRuntimeOptions): OpenCodeLiveRuntime {
  const adapterOptions = {
    command: options.exe,
    shell: false,
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
    // The isolated web-session config file contains the scoped M9R web MCP
    // server and disables OpenCode's own tools. Do not merge in the separate
    // mission-bridge MCP config here.
    serverEnv: () => ({}),
  };
  const adapter = options.adapterFactory?.(adapterOptions) ?? createOpenCodeAcpAdapter(adapterOptions);
  const assignment: ProviderAssignment = {
    missionId: options.missionId,
    dispatchKey: `web-${options.handle}`,
    goal: "Work through the owner's shared M9R browser session using only its governed web tools.",
    executionConstraints: { profile: "web-only" },
    model: options.model,
    effort: options.effort,
  };

  let server: AgentServerHandle | undefined;
  let session: AgentSessionHandle | undefined;
  let startup: Promise<{ sessionId: string; restored?: boolean; availableModels?: readonly ProviderModelOption[] | null }> | undefined;
  let closed = false;

  async function start(): Promise<{ sessionId: string; restored?: boolean; availableModels?: readonly ProviderModelOption[] | null }> {
    if (closed) throw new Error("OpenCode session was closed before it started.");
    const activeServer = await adapter.launchServer({
      assignment,
      environment: { workingDirectory: options.cwd, kind: "shared" },
    });
    server = activeServer;
    try {
      await adapter.initialize(activeServer);
      if (closed) throw new Error("OpenCode session was closed while it started.");
      session = await adapter.createSession({ server: activeServer, assignment });
      const sessionId = session.providerSessionRef;
      if (!sessionId || !PROVIDER_SESSION_ID.test(sessionId)) throw new Error("OpenCode ACP did not return a usable session id.");
      if (closed) throw new Error("OpenCode session was closed while it started.");
      const availableModels = session.availableModels;
      return { sessionId, ...(availableModels !== undefined ? { availableModels } : {}) };
    } catch (error) {
      await adapter.shutdown(activeServer).catch(() => undefined);
      if (server === activeServer) server = undefined;
      session = undefined;
      throw error;
    }
  }

  return {
    alive(): boolean {
      if (closed) return false;
      if (!server) return true; // not launched yet, or still launching
      return adapter.getServerHealth?.(server).state !== "dead";
    },
    ready(): Promise<{ sessionId: string; restored?: boolean; availableModels?: readonly ProviderModelOption[] | null }> {
      if (closed) return Promise.reject(new Error("OpenCode session is closed."));
      startup ??= start().catch((error: unknown) => {
        startup = undefined;
        throw error;
      });
      return startup;
    },
    async configureModel(model: string | null, effort: string | null): Promise<void> {
      if (closed || !session) throw new Error("OpenCode ACP session is not ready.");
      if (!adapter.configureSession) throw new Error("OpenCode ACP does not expose live model configuration.");
      await adapter.configureSession({ session, model, effort });
    },
    async *prompt(text: string, promptOptions?: { onRequestSubmitted?: () => void }): AsyncIterable<InteractiveProviderEvent> {
      if (closed || !session) throw new Error("OpenCode ACP session is not ready.");
      // The ACP adapter's prompt call is the transport submission boundary.
      // Notify the managed owner immediately after creating that request; the
      // adapter then streams the provider result through the same iterator.
      // Keep the callback at this wrapper boundary rather than widening the
      // shared ACP protocol type with an M9R-only option.
      const events = adapter.prompt({ session, text });
      promptOptions?.onRequestSubmitted?.();
      yield* events;
    },
    async cancelTurn(): Promise<void> {
      if (closed || !session) return;
      await adapter.cancelTurn({ session });
    },
    close(): void {
      if (closed) return;
      closed = true;
      session = undefined;
      const activeServer = server;
      server = undefined;
      if (activeServer) void adapter.shutdown(activeServer);
    },
  };
}
