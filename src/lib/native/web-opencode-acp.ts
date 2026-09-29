import { createOpenCodeAcpAdapter, type AcpStdioProviderAdapter } from "@/lib/bridge/acp-stdio-adapter";
import type { AgentServerHandle, AgentSessionHandle, InteractiveProviderEvent } from "@/lib/bridge/interactive-provider-adapter";
import type { ProviderAssignment } from "@/lib/mission/mission-provider-adapter";

export interface OpenCodeLiveRuntime {
  ready(): Promise<{ sessionId: string }>;
  prompt(text: string): AsyncIterable<InteractiveProviderEvent>;
  cancelTurn(): Promise<void>;
  close(): void;
}

export interface OpenCodeLiveRuntimeOptions {
  exe: string;
  cwd: string;
  env: Record<string, string | undefined>;
  handle: string;
  missionId: string;
  model: string;
  resumeId?: string;
  /** Test seam for exercising the ACP lifecycle without spawning a provider binary. */
  adapterFactory?: (options: Parameters<typeof createOpenCodeAcpAdapter>[0]) => Pick<AcpStdioProviderAdapter,
    "launchServer" | "initialize" | "createSession" | "resumeSession" | "prompt" | "cancelTurn" | "shutdown">;
}

const PROVIDER_SESSION_ID = /^ses[_-][A-Za-z0-9_-]{1,100}$/;

/**
 * One provider process and one ACP session per web-agent lifetime. OpenCode
 * owns its conversation history; M9R persists only the provider session id so
 * a broker restart can resume that same conversation without another CLI run
 * process for each message.
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
  };

  let server: AgentServerHandle | undefined;
  let session: AgentSessionHandle | undefined;
  let startup: Promise<{ sessionId: string }> | undefined;
  let closed = false;

  async function start(): Promise<{ sessionId: string }> {
    if (closed) throw new Error("OpenCode session was closed before it started.");
    const activeServer = await adapter.launchServer({
      assignment,
      environment: { workingDirectory: options.cwd, kind: "shared" },
    });
    server = activeServer;
    try {
      await adapter.initialize(activeServer);
      if (closed) throw new Error("OpenCode session was closed while it started.");
      session = options.resumeId && PROVIDER_SESSION_ID.test(options.resumeId)
        ? await adapter.resumeSession({ server: activeServer, providerSessionRef: options.resumeId, assignment })
        : await adapter.createSession({ server: activeServer, assignment });
      const sessionId = session.providerSessionRef;
      if (!sessionId || !PROVIDER_SESSION_ID.test(sessionId)) throw new Error("OpenCode ACP did not return a resumable session id.");
      if (closed) throw new Error("OpenCode session was closed while it started.");
      return { sessionId };
    } catch (error) {
      await adapter.shutdown(activeServer).catch(() => undefined);
      if (server === activeServer) server = undefined;
      session = undefined;
      throw error;
    }
  }

  return {
    ready(): Promise<{ sessionId: string }> {
      if (closed) return Promise.reject(new Error("OpenCode session is closed."));
      startup ??= start().catch((error: unknown) => {
        startup = undefined;
        throw error;
      });
      return startup;
    },
    async *prompt(text: string): AsyncIterable<InteractiveProviderEvent> {
      if (closed || !session) throw new Error("OpenCode ACP session is not ready.");
      yield* adapter.prompt({ session, text });
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
