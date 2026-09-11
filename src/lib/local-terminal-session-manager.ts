import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { providerProcessSpec, resolveWorkspaceCwd, type TerminalProvider } from "@/lib/local-terminal-bridge-core";
import type { ResidentActivityEvent } from "@/lib/resident-activity-journal";

export interface PtyHandle {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  name: string;
  useConptyDll?: boolean;
  conptyInheritCursor?: boolean;
}

export interface PtyFactory {
  spawn(command: string, args: readonly string[], options: PtySpawnOptions): PtyHandle;
}

export interface TerminalOutputEvent {
  type: "output";
  sessionId: string;
  data: string;
  replay?: boolean;
}

export interface TerminalSessionView {
  id: string;
  provider: TerminalProvider;
  cwd: string;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  lastActivityAt: string;
  agentState: "idle" | "working" | "blocked" | "exited";
  source: "interactive" | "resident";
  interactive: boolean;
  grantId: string | null;
}

interface TerminalSession extends TerminalSessionView {
  pty: PtyHandle | null;
  replay: string;
  listeners: Set<(event: TerminalOutputEvent) => void>;
  closing: boolean;
  activitySequence: number;
}

const PRIVATE_ENV_KEYS = new Set([
  "OATHLOCK_AGENT_TOKEN",
  "OATHLOCK_BRIDGE_TOKEN",
  "OATHLOCK_TOKEN",
]);

export function sanitizeTerminalEnvironment(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => typeof value === "string" && !PRIVATE_ENV_KEYS.has(key) && !key.startsWith("OATHLOCK_SECRET_")) as Array<[string, string]>,
  );
}

function publicView(session: TerminalSession): TerminalSessionView {
  const { id, provider, cwd, pid, status, exitCode, startedAt, lastActivityAt, agentState, source, interactive, grantId } = session;
  return { id, provider, cwd, pid, status, exitCode, startedAt, lastActivityAt, agentState, source, interactive, grantId };
}

export function createTerminalSessionManager(options: {
  repositoryRoot: string;
  ptyFactory: PtyFactory;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  maxReplayBytes?: number;
  onSessionsChanged?: (sessions: TerminalSessionView[]) => void;
}) {
  const sessions = new Map<string, TerminalSession>();
  const maxReplayBytes = options.maxReplayBytes ?? 512 * 1024;
  const env = sanitizeTerminalEnvironment(options.env ?? process.env);

  function requireSession(sessionId: string): TerminalSession {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Terminal session ${sessionId} was not found.`);
    return session;
  }

  function appendReplay(session: TerminalSession, data: string): void {
    const merged = Buffer.from(session.replay + data);
    session.replay = merged.length <= maxReplayBytes
      ? merged.toString("utf8")
      : merged.subarray(merged.length - maxReplayBytes).toString("utf8");
  }

  function notifySessionsChanged(): void {
    options.onSessionsChanged?.([...sessions.values()].map(publicView));
  }

  return {
    spawn(input: { provider: TerminalProvider; cwd: string; cols: number; rows: number }): TerminalSession {
      const launcher = providerProcessSpec(input.provider);
      const cwd = resolveWorkspaceCwd(options.repositoryRoot, input.cwd);
      const id = randomUUID();
      const pty = options.ptyFactory.spawn(launcher.command, launcher.args, {
        cwd,
        cols: input.cols,
        rows: input.rows,
        env: { ...env, OATHLOCK_AGENT_KIND: input.provider, OATHLOCK_TERMINAL_SESSION_ID: id, TERM: env.TERM ?? "xterm-256color" },
        name: "xterm-256color",
        ...(process.platform === "win32" ? { useConptyDll: true, conptyInheritCursor: true } : {}),
      });
      const now = new Date().toISOString();
      const session: TerminalSession = {
        id,
        provider: input.provider,
        cwd,
        pid: pty.pid,
        status: "running",
        exitCode: null,
        startedAt: now,
        lastActivityAt: now,
        agentState: "idle",
        source: "interactive",
        interactive: true,
        grantId: null,
        pty,
        replay: "",
        listeners: new Set(),
        closing: false,
        activitySequence: 0,
      };
      sessions.set(session.id, session);
      notifySessionsChanged();
      pty.onData((data) => {
        session.lastActivityAt = new Date().toISOString();
        appendReplay(session, data);
        for (const listener of session.listeners) listener({ type: "output", sessionId: session.id, data });
      });
      pty.onExit(({ exitCode }) => {
        session.status = "exited";
        session.exitCode = exitCode;
        session.lastActivityAt = new Date().toISOString();
        session.agentState = "exited";
        session.closing = false;
        notifySessionsChanged();
      });
      return session;
    },

    list(): TerminalSessionView[] {
      return [...sessions.values()].map(publicView);
    },

    listFor(provider: TerminalProvider, source?: "interactive" | "resident"): TerminalSessionView[] {
      return [...sessions.values()]
        .filter((session) => session.provider === provider && (!source || session.source === source))
        .map(publicView);
    },

    requireProvider(sessionId: string, provider: TerminalProvider): void {
      if (requireSession(sessionId).provider !== provider) throw new Error("Terminal session belongs to another provider connection.");
    },

    requireObserved(sessionId: string): void {
      if (requireSession(sessionId).source !== "resident") throw new Error("Hosted Watchfloor connections may observe bounded resident assignments only.");
    },

    attach(sessionId: string, listener: (event: TerminalOutputEvent) => void): () => void {
      const session = requireSession(sessionId);
      if (session.replay) listener({ type: "output", sessionId, data: session.replay, replay: true });
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },

    observe(event: ResidentActivityEvent): TerminalSessionView {
      const id = `resident:${event.grantId}`;
      let session = sessions.get(id);
      if (!session) {
        if (event.kind !== "started" && event.kind !== "output") throw new Error("Observed resident session has not started.");
        session = {
          id,
          provider: event.provider,
          cwd: resolve(options.repositoryRoot),
          pid: 0,
          status: "running",
          exitCode: null,
          startedAt: event.occurredAt,
          lastActivityAt: event.occurredAt,
          agentState: "working",
          source: "resident",
          interactive: false,
          grantId: event.grantId,
          pty: null,
          replay: "",
          listeners: new Set(),
          closing: false,
          activitySequence: 0,
        };
        sessions.set(id, session);
      }
      if (event.sequence <= session.activitySequence) return publicView(session);
      session.activitySequence = event.sequence;
      session.lastActivityAt = event.occurredAt;
      if (event.data) {
        appendReplay(session, event.data);
        for (const listener of session.listeners) listener({ type: "output", sessionId: id, data: event.data });
      }
      if (event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled") {
        session.status = "exited";
        session.exitCode = event.kind === "completed" ? 0 : 1;
        session.agentState = event.kind === "completed" ? "exited" : "blocked";
      }
      notifySessionsChanged();
      return publicView(session);
    },

    write(sessionId: string, data: string): void {
      const session = requireSession(sessionId);
      if (session.status !== "running") throw new Error("Terminal session has exited.");
      if (!session.interactive || !session.pty) throw new Error("Resident assignment sessions are read-only observers.");
      session.pty.write(data);
    },

    resize(sessionId: string, cols: number, rows: number): void {
      const session = requireSession(sessionId);
      if (session.status !== "running") return;
      session.pty?.resize(cols, rows);
    },

    reportState(sessionId: string, state: "idle" | "working" | "blocked"): void {
      const session = requireSession(sessionId);
      if (session.status !== "running") throw new Error("Terminal session has exited.");
      session.agentState = state;
      session.lastActivityAt = new Date().toISOString();
      notifySessionsChanged();
    },

    close(sessionId: string): void {
      const session = requireSession(sessionId);
      if (session.status === "running" && !session.closing) {
        if (!session.interactive || !session.pty) throw new Error("Resident assignment sessions are read-only and controlled by their launch grant.");
        session.closing = true;
        session.pty.kill();
      }
    },

    shutdown(): void {
      for (const session of sessions.values()) {
        if (session.status === "running" && !session.closing) {
          session.closing = true;
          session.pty?.kill();
        }
      }
    },
  };
}
