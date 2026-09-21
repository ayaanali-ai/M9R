/**
 * Hook-free Codex mentions, I/O half (the parsing is in codex-watch-core.ts). Runs inside the feed writer: it follows the
 * rollout files of recently active Codex sessions, and when a person typed an `@agent` prompt it creates the task the
 * hook would have, about a second after Codex records it. It only reads Codex's own files.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { routeTypedMentions } from "./hook-handler";
import type { LocalStore } from "./local-store";
import { consumeRollout, newWatchFile, type WatchFile } from "./codex-watch-core";

const ACTIVE_WINDOW_MS = 20 * 60_000;
/** Sessions this recent are offered to `@codex` as targets (the same window delivery uses). */
const KNOWN_WINDOW_MS = 12 * 60 * 60_000;
const MAX_READ = 4 * 1024 * 1024;

export interface CodexWatchOptions {
  /** Codex's home (`~/.codex`); rollouts live in `sessions/YYYY/MM/DD`. */
  codexHome: string;
  dispatch?: (taskId: string) => void;
  now?: () => number;
  /** Turn typed `@agent` prompts into tasks. Off when Codex has not been told to stand down (discovery of sessions still runs). Default on. */
  routeMentions?: boolean;
}

export interface CodexWatcher {
  /** Finds active rollout files (walks the sessions folder; call every few seconds). */
  refresh(): void;
  /** Reads new lines from tracked files and routes typed mentions. Returns the number of tasks created. */
  tick(): number;
}

/** The first line of a rollout names the session: id, folder, and (for sub-agents such as the approval guardian) an object source. */
function readMeta(path: string): { id: string; cwd?: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(32 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.toString("utf8", 0, n).split(String.fromCharCode(10))[0];
    const rec = JSON.parse(first) as { type?: string; payload?: { id?: string; cwd?: string; source?: unknown } };
    const p = rec.payload;
    if (rec.type !== "session_meta" || !p || typeof p.id !== "string" || (p.source !== null && typeof p.source === "object")) return null;
    return { id: p.id, cwd: typeof p.cwd === "string" ? p.cwd : undefined };
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
}

function walk(dir: string, out: string[], depth = 0): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) walk(full, out, depth + 1); } else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
  }
}

export function createCodexWatcher(store: LocalStore, options: CodexWatchOptions): CodexWatcher {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const files = new Map<string, WatchFile & { touchedAt: number }>();
  const sessionsDir = join(options.codexHome, "sessions");
  /** Rollouts already offered to `@codex`, so a session is registered once, with no Codex hook and no trust step. */
  const known = new Set<string>();

  return {
    refresh() {
      if (!existsSync(sessionsDir)) return;
      const found: string[] = [];
      walk(sessionsDir, found);
      for (const path of found) {
        let st;
        try { st = statSync(path); } catch { continue; }
        // Hook-free discovery: every real Codex session of the last day becomes a target for `@codex` (delivery still asks the machine
        // which ones are open, and never guesses between several).
        if (!known.has(path) && now() - st.mtimeMs <= KNOWN_WINDOW_MS) {
          known.add(path);
          const meta = readMeta(path);
          if (meta) store.registerEndpoint({ provider: "codex", sessionId: meta.id, cwd: meta.cwd, seenAt: new Date(st.mtimeMs).toISOString() });
        }
        const tracked = files.get(path);
        if (tracked) { if (st.size > tracked.offset) { tracked.touchedAt = now(); if (tracked.id) store.registerEndpoint({ provider: "codex", sessionId: tracked.id, cwd: tracked.cwd, seenAt: new Date(st.mtimeMs).toISOString() }); } continue; }
        if (now() - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
        // A session that began after we started is read from its first line; one that was already running is read from now on.
        const fresh = st.birthtimeMs >= startedAt;
        files.set(path, { ...newWatchFile(fresh ? 0 : st.size), touchedAt: now() });
      }
      for (const [path, f] of files) if (now() - f.touchedAt > ACTIVE_WINDOW_MS) files.delete(path);
    },

    tick() {
      let created = 0;
      if (options.routeMentions === false) return 0;
      for (const [path, f] of files) {
        let size: number;
        try { size = statSync(path).size; } catch { files.delete(path); continue; }
        if (size <= f.offset) continue;
        f.touchedAt = now();
        const want = Math.min(size - f.offset, MAX_READ);
        const buf = Buffer.alloc(want);
        let fd: number | null = null;
        try { fd = openSync(path, "r"); readSync(fd, buf, 0, want, f.offset); } catch { continue; } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
        const text = buf.toString("utf8");
        const { events, consumedChars } = consumeRollout(text, f);
        f.offset += Buffer.byteLength(text.slice(0, consumedChars));
        for (const ev of events) {
          if (ev.kind === "prompt") {
            const { tasks } = routeTypedMentions({ hook_event_name: "UserPromptSubmit", prompt: ev.text, session_id: f.id, cwd: f.cwd }, { provider: "codex", store, dispatch: options.dispatch });
            if (tasks.length > 0) { created += tasks.length; f.turn = { taskId: tasks[0].id, worked: false }; }
          } else if (ev.kind === "work" && f.turn && !f.turn.worked) {
            f.turn.worked = true;
            store.noteEvent("mention.double", `Codex started working on a message that M9R forwarded (${f.turn.taskId}). It may be done twice.`, f.turn.taskId);
          } else if (ev.kind === "turn_end") f.turn = undefined;
        }
      }
      return created;
    },
  };
}
