/** Pure planning and lifecycle primitives for owner-hosted agent sessions. */
import { posix, win32 } from "node:path";
import { buildVendorLaunchPlan, type M9rLaunchProfile } from "./vendor-launch-core";
import { encodeUserMessage, signUserMessage } from "./live-session-core";
import { isThreadId, queueArgs } from "./codex-delivery-core";

export type HostedVendor = "claude" | "codex";
export type HostedSessionStatus = "starting" | "active" | "idle" | "sleeping" | "stopped" | "failed";
export type HostedFailureCode = "spawn_failed" | "pty_lost" | "vendor_error" | "unknown";

export interface HostedAgentKey {
  roomId: string;
  projectFolder: string;
  vendor: HostedVendor;
  agentId: string;
}

export interface HostedAgentSession extends HostedAgentKey {
  id: string;
  status: HostedSessionStatus;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  ptySessionId?: string;
  vendorSessionId?: string;
  resumeCount: number;
  failureCode?: HostedFailureCode;
}

export interface HostedSessionState {
  sessions: HostedAgentSession[];
}

type HostedEvent =
  | { type: "ensure"; key: HostedAgentKey; sessionId: string; now: number }
  | { type: "ready"; id: string; now: number; ptySessionId?: string; vendorSessionId?: string }
  | { type: "activity"; id: string; now: number }
  | { type: "idle"; id: string; now: number }
  | { type: "idle-sweep"; now: number; idleAfterMs: number }
  | { type: "wake"; id: string; now: number }
  | { type: "stop"; id: string; now: number }
  | { type: "fail"; id: string; now: number; reason: HostedFailureCode };

export interface HostedTransition {
  ok: boolean;
  action: "started" | "reused" | "waking" | "ready" | "active" | "idle" | "slept" | "stopped" | "failed" | "unchanged" | "missing" | "conflict";
  state: HostedSessionState;
  session?: HostedAgentSession;
  error?: string;
}

const LIVE_STATUSES = new Set<HostedSessionStatus>(["starting", "active", "idle", "sleeping"]);
export const initialHostedSessionState = (): HostedSessionState => ({ sessions: [] });

/** Normalize absolute project paths without merging case-sensitive POSIX paths. */
export function normalizeProjectFolder(folder: string, platform: NodeJS.Platform = process.platform): string | null {
  const value = folder.trim();
  if (!value) return null;
  if (platform === "win32") {
    if (!win32.isAbsolute(value)) return null;
    const normalized = win32.normalize(value).replace(/\\/g, "/");
    if (/^[a-z]:\/$/i.test(normalized)) return normalized.toLowerCase();
    return normalized.replace(/\/+$/, "").toLowerCase() || "/";
  }
  if (!posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function stableKey(key: HostedAgentKey): string | null {
  const projectFolder = normalizeProjectFolder(key.projectFolder);
  if (!projectFolder || !key.roomId.trim() || !key.agentId.trim()) return null;
  return JSON.stringify([key.roomId, projectFolder, key.vendor, key.agentId]);
}

function sessionKey(session: HostedAgentKey): string | null {
  return stableKey(session);
}

function replaceSession(state: HostedSessionState, id: string, update: (current: HostedAgentSession) => HostedAgentSession): HostedTransition {
  const index = state.sessions.findIndex((session) => session.id === id);
  if (index < 0) return { ok: false, action: "missing", state, error: "session not found" };
  const sessions = [...state.sessions];
  sessions[index] = update(sessions[index]);
  return { ok: true, action: "unchanged", state: { ...state, sessions }, session: sessions[index] };
}

/** Idempotent owner-local session registry transition. Duplicate live keys fail closed. */
export function transitionHostedSessions(state: HostedSessionState, event: HostedEvent): HostedTransition {
  if (event.type === "ensure") {
    const key = stableKey(event.key);
    if (!key) return { ok: false, action: "conflict", state, error: "room, absolute project folder, vendor, and agent are required" };
    const matches = state.sessions.filter((session) => LIVE_STATUSES.has(session.status) && sessionKey(session) === key);
    if (matches.length > 1) return { ok: false, action: "conflict", state, error: "multiple live sessions share this logical agent key" };
    const existing = matches[0];
    if (existing?.status === "sleeping") {
      const woken = { ...existing, status: "starting" as const, updatedAt: event.now, lastActivityAt: event.now, resumeCount: existing.resumeCount + 1 };
      return { ok: true, action: "waking", state: { ...state, sessions: state.sessions.map((item) => item.id === existing.id ? woken : item) }, session: woken };
    }
    if (existing) return { ok: true, action: "reused", state, session: existing };
    if (!event.sessionId.trim() || state.sessions.some((session) => session.id === event.sessionId)) {
      return { ok: false, action: "conflict", state, error: "session id must be non-empty and unique" };
    }
    const session: HostedAgentSession = {
      ...event.key,
      projectFolder: normalizeProjectFolder(event.key.projectFolder)!,
      id: event.sessionId,
      status: "starting",
      createdAt: event.now,
      updatedAt: event.now,
      lastActivityAt: event.now,
      resumeCount: 0,
    };
    return { ok: true, action: "started", state: { ...state, sessions: [...state.sessions, session] }, session };
  }

  if (event.type === "idle-sweep") {
    if (!Number.isFinite(event.idleAfterMs) || event.idleAfterMs < 0) return { ok: false, action: "unchanged", state, error: "idle timeout must be a non-negative finite duration" };
    let slept = 0;
    const sessions = state.sessions.map((session) => {
      const quiet = event.now - session.lastActivityAt >= event.idleAfterMs;
      if ((session.status === "active" || session.status === "idle") && quiet) {
        slept += 1;
        return { ...session, status: "sleeping" as const, updatedAt: event.now };
      }
      return session;
    });
    const changed = sessions.filter((session, index) => session !== state.sessions[index]);
    const nextState = slept ? { ...state, sessions } : state;
    const onlyRelevantSession = changed.length === 1 ? changed[0] : changed.length === 0 && sessions.length === 1 ? sessions[0] : undefined;
    return { ok: true, action: slept ? "slept" : "unchanged", state: nextState, session: onlyRelevantSession };
  }

  if (event.type === "ready") {
    const current = state.sessions.find((session) => session.id === event.id);
    if (!current) return { ok: false, action: "missing", state, error: "session not found" };
    if (current.status !== "starting") return { ok: false, action: "unchanged", state, session: current, error: "only a starting session can become ready" };
    const result = replaceSession(state, event.id, (session) => ({ ...session, status: "active", ptySessionId: event.ptySessionId ?? session.ptySessionId, vendorSessionId: event.vendorSessionId ?? session.vendorSessionId, updatedAt: event.now, lastActivityAt: event.now, failureCode: undefined }));
    return result.session ? { ...result, action: "ready" } : result;
  }
  if (event.type === "activity") {
    const current = state.sessions.find((session) => session.id === event.id);
    if (!current) return { ok: false, action: "missing", state, error: "session not found" };
    if (current.status !== "active" && current.status !== "idle") return { ok: false, action: "unchanged", state, session: current, error: "activity requires an active session; sleeping sessions must use wake" };
    const result = replaceSession(state, event.id, (session) => ({ ...session, status: "active", updatedAt: event.now, lastActivityAt: event.now }));
    return result.session ? { ...result, action: "active" } : result;
  }
  if (event.type === "idle") {
    const current = state.sessions.find((session) => session.id === event.id);
    if (!current) return { ok: false, action: "missing", state, error: "session not found" };
    if (current.status === "idle") return { ok: true, action: "unchanged", state, session: current };
    if (current.status !== "active") return { ok: false, action: "unchanged", state, session: current, error: "only an active session can become idle" };
    const result = replaceSession(state, event.id, (session) => ({ ...session, status: "idle", updatedAt: event.now }));
    return result.session ? { ...result, action: "idle" } : result;
  }
  if (event.type === "wake") {
    const current = state.sessions.find((session) => session.id === event.id);
    if (!current) return { ok: false, action: "missing", state, error: "session not found" };
    if (current.status !== "sleeping") return { ok: false, action: "unchanged", state, session: current, error: "only a sleeping session can be woken" };
    const result = replaceSession(state, event.id, (session) => ({ ...session, status: "starting", updatedAt: event.now, lastActivityAt: event.now, resumeCount: session.resumeCount + 1 }));
    return result.session ? { ...result, action: "waking" } : result;
  }
  if (event.type === "stop") {
    const current = state.sessions.find((session) => session.id === event.id);
    if (!current) return { ok: false, action: "missing", state, error: "session not found" };
    if (!LIVE_STATUSES.has(current.status)) return { ok: false, action: "unchanged", state, session: current, error: "session is already terminal" };
    const result = replaceSession(state, event.id, (session) => ({ ...session, status: "stopped", updatedAt: event.now }));
    return result.session ? { ...result, action: "stopped" } : result;
  }
  const current = state.sessions.find((session) => session.id === event.id);
  if (!current) return { ok: false, action: "missing", state, error: "session not found" };
  if (!LIVE_STATUSES.has(current.status)) return { ok: false, action: "unchanged", state, session: current, error: "session is already terminal" };
  const result = replaceSession(state, event.id, (session) => ({ ...session, status: "failed", failureCode: event.reason, updatedAt: event.now }));
  return result.session ? { ...result, action: "failed" } : result;
}

export interface HostedLaunchConfig {
  vendor: HostedVendor;
  profile: M9rLaunchProfile;
  projectFolder: string;
  mcpConfigPath: string;
  promptFile: string;
  mcpCommand: string;
  mcpArgs: string[];
  mcpEnv: Record<string, string>;
  sessionToken: string;
  resumeSessionId?: string;
}

/** Produces a spawn plan only; it never spawns a vendor process or exposes the token in argv. */
export function buildHostedAgentLaunchPlan(config: HostedLaunchConfig): { command: string; args: string[]; mcpConfigJson?: string; promptFileContent?: string; stdinPrompt?: string } {
  const cwd = normalizeProjectFolder(config.projectFolder);
  if (!cwd) throw new Error("project folder must be absolute");
  if (config.resumeSessionId !== undefined && (!config.resumeSessionId.trim() || config.resumeSessionId.length > 256)) throw new Error("resume session id is invalid");
  const plan = buildVendorLaunchPlan({ ...config, cwd });
  if (config.vendor === "claude" && config.resumeSessionId) plan.args.push("--resume", config.resumeSessionId);
  return plan;
}

export type HostedWakePlan =
  | { ok: true; plan: { kind: "codex-queue"; command: "codex"; args: string[] } }
  | { ok: true; plan: { kind: "claude-pty-input"; line: string } }
  | { ok: false; error: string };

/** Plans a message for an already-authorized host; dispatch and human-origin checks remain the caller's duty. */
export function buildHostedWakePlan(input: { vendor: HostedVendor; threadId?: string; marker?: string; text: string }): HostedWakePlan {
  if (!input.text.trim() || input.text.length > 20_000) return { ok: false, error: "wake message must contain 1 to 20000 characters" };
  if (input.vendor === "codex") {
    if (!isThreadId(input.threadId)) return { ok: false, error: "a valid Codex thread id is required" };
    return { ok: true, plan: { kind: "codex-queue", command: "codex", args: queueArgs(input.threadId, input.text) } };
  }
  if (!input.marker || !/^M9R-USER-[A-Za-z0-9_-]{8,64}$/.test(input.marker)) return { ok: false, error: "a session-authenticated Claude message marker is required" };
  return { ok: true, plan: { kind: "claude-pty-input", line: encodeUserMessage(signUserMessage(input.marker, input.text)) } };
}
