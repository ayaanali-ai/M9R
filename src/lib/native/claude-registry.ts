/**
 * Claude Code publishes a small registry of its open sessions: `~/.claude/sessions/<pid>.json` with the pid, session id,
 * working folder, and whether it is busy or idle. That is enough to show "open, idle / working" on the pill with no hook.
 *
 * Only the `.json` files are read, and only these five fields. The `.key` files next to them are credentials and are never
 * opened; the messaging socket path is never used.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeSession {
  sessionId: string;
  pid: number;
  cwd?: string;
  status: "busy" | "idle" | "unknown";
  /** Milliseconds since the epoch of the last status change. */
  updatedAt?: number;
}

export function claudeSessionsDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "sessions");
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Open Claude Code sessions on this machine: registry entries whose process is still running. */
export function readClaudeSessions(dir = claudeSessionsDir(), isAlive: (pid: number) => boolean = alive): ClaudeSession[] {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: ClaudeSession[] = [];
  for (const name of names) {
    try {
      const j = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown; cwd?: unknown; status?: unknown; updatedAt?: unknown };
      if (typeof j.pid !== "number" || typeof j.sessionId !== "string" || !isAlive(j.pid)) continue;
      out.push({
        sessionId: j.sessionId, pid: j.pid,
        cwd: typeof j.cwd === "string" ? j.cwd : undefined,
        status: j.status === "busy" ? "busy" : j.status === "idle" ? "idle" : "unknown",
        updatedAt: typeof j.updatedAt === "number" ? j.updatedAt : undefined,
      });
    } catch { /* half-written or not ours: skip */ }
  }
  return out;
}
