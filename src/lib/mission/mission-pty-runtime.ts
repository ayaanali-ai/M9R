import { randomUUID } from "node:crypto";
import { MissionPtyHost, type PtyProcess, type PtySpawnRequest } from "./mission-pty-host";
import {
  parsePtyInputPayload,
  parsePtyResizePayload,
  type PtySessionStatus,
} from "./mission-pty-protocol";
import type { RelayFrame } from "./mission-relay-protocol";

/**
 * Runs the real terminal processes for this machine and keeps them in sync
 * with the Relay.
 *
 * This replaces the old loopback-only terminal bridge rather than extending
 * it: that one served a single local viewer over its own private port, which
 * is the wrong shape for a pane other people can watch and type into. Here the
 * Relay is the only transport, so a session is reachable by everyone in the
 * room under the same auth as the rest of the workspace.
 */

export interface PtyRuntimeTransport {
  sendTerminalFrame(input: { channelId: string; type: "pty.open" | "pty.output" | "pty.close"; payload: Record<string, unknown> }): Promise<void>;
}

/**
 * Tracks which rooms the Relay has actually confirmed this connection into.
 *
 * The Relay handles each inbound frame fire-and-forget, and `workspace.subscribe`
 * does a database round-trip before the subscription is registered -- while
 * `subscribeWorkspace()` resolves as soon as the frame is written to the socket.
 * Announcing a terminal immediately after subscribing therefore loses a real
 * race and gets refused with `pty_subscription_required`, which is the Relay
 * correctly refusing to let an unsubscribed connection touch a room's shell.
 * Waiting for the room's snapshot is the only honest signal that the
 * subscription exists.
 */
export class WorkspaceRoomReadiness {
  private readonly confirmed = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  /** Feed every inbound relay frame through this. */
  observe(frame: { type: string; channelId?: string }): void {
    if (frame.type !== "workspace.snapshot" || !frame.channelId) return;
    this.confirmed.add(frame.channelId);
    for (const resolve of this.waiters.get(frame.channelId) ?? []) resolve();
    this.waiters.delete(frame.channelId);
  }

  /** A dropped socket clears confirmation, so a reconnect re-waits. */
  forget(channelId?: string): void {
    if (channelId) this.confirmed.delete(channelId);
    else this.confirmed.clear();
  }

  async wait(channelId: string, timeoutMs = 15_000): Promise<void> {
    if (this.confirmed.has(channelId)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.set(channelId, (this.waiters.get(channelId) ?? []).filter((entry) => entry !== onReady));
        reject(new Error(`The relay did not confirm the subscription to ${channelId} in time.`));
      }, timeoutMs);
      const onReady = () => { clearTimeout(timer); resolve(); };
      this.waiters.set(channelId, [...(this.waiters.get(channelId) ?? []), onReady]);
    });
  }
}

export interface PtyRuntimeOptions {
  transport: PtyRuntimeTransport;
  spawn(request: PtySpawnRequest): PtyProcess;
  /** Defaults to the platform's login shell. */
  defaultShell?: string;
  defaultCwd?: string;
  env?: Record<string, string>;
  onError?: (error: Error) => void;
}

interface RuntimeSession {
  sessionId: string;
  channelId: string;
  host: MissionPtyHost;
  status: PtySessionStatus;
}

export function defaultShellForPlatform(platform: NodeJS.Platform, env: Record<string, string | undefined>): { shell: string; args: string[] } {
  if (platform === "win32") return { shell: env.COMSPEC ?? "powershell.exe", args: [] };
  return { shell: env.SHELL ?? "/bin/bash", args: ["-l"] };
}

export class MissionPtyRuntime {
  private readonly options: PtyRuntimeOptions;
  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(options: PtyRuntimeOptions) {
    this.options = options;
  }

  get activeSessionIds(): string[] {
    return [...this.sessions.values()].filter((session) => session.status === "running").map((session) => session.sessionId);
  }

  /** Starts a terminal and announces it to the room. */
  async open(input: { channelId: string; cols: number; rows: number; title?: string; cwd?: string; sessionId?: string }): Promise<string> {
    const sessionId = input.sessionId ?? `pty-${randomUUID()}`;
    const { shell, args } = defaultShellForPlatform(process.platform, process.env);
    const host = new MissionPtyHost({
      sessionId,
      spawn: this.options.spawn,
      publishOutput: (output) => {
        void this.options.transport
          .sendTerminalFrame({ channelId: input.channelId, type: "pty.output", payload: { ...output } })
          .catch((error) => this.options.onError?.(error instanceof Error ? error : new Error(String(error))));
      },
      publishExit: (event) => {
        const session = this.sessions.get(sessionId);
        if (session) session.status = "exited";
        void this.options.transport
          .sendTerminalFrame({ channelId: input.channelId, type: "pty.close", payload: { sessionId, reason: `exited with code ${event.exitCode}` } })
          .catch((error) => this.options.onError?.(error instanceof Error ? error : new Error(String(error))));
      },
    });

    this.sessions.set(sessionId, { sessionId, channelId: input.channelId, host, status: "running" });

    // Announced before the process starts, so the room has a pane to render
    // into by the time the shell's first prompt arrives.
    await this.options.transport.sendTerminalFrame({
      channelId: input.channelId,
      type: "pty.open",
      payload: { sessionId, cols: input.cols, rows: input.rows, ...(input.title === undefined ? {} : { title: input.title }) },
    });

    host.start({
      shell: this.options.defaultShell ?? shell,
      args,
      cwd: input.cwd ?? this.options.defaultCwd ?? process.cwd(),
      cols: input.cols,
      rows: input.rows,
      env: this.options.env ?? {},
    });

    return sessionId;
  }

  /**
   * Applies an inbound relay frame. Returns whether it was handled, so a
   * caller can keep its own frame routing exhaustive.
   */
  handleFrame(frame: RelayFrame): boolean {
    if (frame.type === "pty.input") {
      const payload = parsePtyInputPayload(frame.payload);
      if (!payload) return false;
      this.sessions.get(payload.sessionId)?.host.applyInput(payload);
      return true;
    }
    if (frame.type === "pty.resize") {
      const payload = parsePtyResizePayload(frame.payload);
      if (!payload) return false;
      this.sessions.get(payload.sessionId)?.host.applyResize(payload);
      return true;
    }
    if (frame.type === "pty.state") {
      // The only state the Relay sends back to a host is a viewer asking to
      // close; the host stays the authority on ending its own process.
      const payload = frame.payload as { sessionId?: unknown; reason?: unknown } | null;
      if (payload?.reason === "close_requested" && typeof payload.sessionId === "string") {
        this.close(payload.sessionId);
        return true;
      }
      return false;
    }
    return false;
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.host.stop();
    session.status = "exited";
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.host.stop();
    this.sessions.clear();
  }
}

/** Lazily required so importing this module never forces the native build. */
/**
 * Prefixes of environment variables that mark *this* process's own agent
 * session state -- confirmed by direct inspection (`CLAUDE_CODE_CHILD_SESSION`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_PID`,
 * `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, and others all
 * present on the process hosting a terminal pane, none of them anything a
 * user sets intentionally). `node-pty` inherits `process.env` by default, so
 * without stripping these, a person typing `claude` inside a pane launches
 * into a *child* of whatever session happened to be hosting the pane --
 * marked non-resumable, not the normal top-level session Mosaic's demo shows
 * and the one this feature needs to produce. Prefix-based, not an exhaustive
 * name list, and deliberately structured to grow: add another provider's own
 * session-marker prefix here the same way once it's confirmed, rather than
 * guessing at names that haven't been directly observed.
 */
const AGENT_SESSION_ENV_PREFIXES = ["CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_", "CLAUDE_PREVIEW_"];

export function isAgentSessionEnvVar(name: string): boolean {
  return AGENT_SESSION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** A clean base environment a freshly-typed provider CLI can start a real, independent top-level session in. */
function baseTerminalEnv(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isAgentSessionEnvVar(key)) clean[key] = value;
  }
  return clean;
}

export async function createNodePtySpawner(): Promise<(request: PtySpawnRequest) => PtyProcess> {
  const nodePty = await import("node-pty");
  return (request: PtySpawnRequest) => {
    const child = nodePty.spawn(request.shell, request.args, {
      name: "xterm-color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: { ...baseTerminalEnv(), ...request.env },
    });
    return {
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: () => child.kill(),
      onData: (listener) => { child.onData(listener); },
      onExit: (listener) => { child.onExit(({ exitCode }) => listener({ exitCode })); },
    };
  };
}
