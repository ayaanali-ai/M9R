/**
 * One hook call, as a function: given the event JSON an agent sent, return the text the hook prints. Used by the small hook
 * program (`m9r-hook.js`) and by the resident engine's hook server, so there is a single copy of the logic.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalStore, defaultStoreRoot } from "./local-store";
import { handleHookEvent, type HookInput } from "./hook-handler";
import { collectCodexResults, deliverToCodex, pushAnswerToCodex, realDeps, spawnDeliveryRunner } from "./codex-delivery";

export interface HookRequest {
  event: string;
  provider: string;
  input: HookInput | null;
  /** Only the few settings the hook reads (M9R_HOME, CODEX_HOME, PATH...); the caller's own environment, not the server's. */
  env?: Record<string, string | undefined>;
}

/** The last thing Claude said in a session: the final assistant message in its transcript. Only the tail of the file is read. */
export function lastClaudeAnswer(input: HookInput, env: Record<string, string | undefined> = process.env): string | null {
  try {
    let file = input.transcript_path && existsSync(input.transcript_path) ? input.transcript_path : null;
    if (!file && input.session_id) {
      const projects = join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
      for (const dir of readdirSync(projects)) { const p = join(projects, dir, `${input.session_id}.jsonl`); if (existsSync(p)) { file = p; break; } }
    }
    if (!file) return null;
    const size = statSync(file).size;
    const start = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split(String.fromCharCode(10));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"assistant"')) continue;
      const rec = JSON.parse(lines[i]) as { type?: string; message?: { role?: string; content?: unknown } };
      if (rec.type !== "assistant" && rec.message?.role !== "assistant") continue;
      const content = rec.message?.content;
      const text = Array.isArray(content) ? content.filter((c: { type?: string }) => c?.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n").trim() : typeof content === "string" ? content.trim() : "";
      if (text) return text.slice(0, 1500);
    }
  } catch { /* no transcript, or a half-written line: no answer this time */ }
  return null;
}

/**
 * `runnerEntry` is what a detached Codex push re-launches: the engine executable, or the hook script for node. With
 * `inProcess` (the resident engine) the push runs right here instead: starting a second copy of the 92 MB engine cold took
 * 5 s or more, which is most of the delay between typing `@codex` and Codex receiving it.
 */
export function runHookRequest(req: HookRequest, runnerEntry: string, baseEnv: Record<string, string | undefined> = process.env, inProcess = false): string {
  const env = { ...baseEnv, ...(req.env ?? {}) };
  const store = createLocalStore(defaultStoreRoot(homedir(), env));
  const deps = realDeps(env);
  const input: HookInput = { ...(req.input ?? {}) };
  if (!input.hook_event_name && req.event) input.hook_event_name = req.event;
  const result = handleHookEvent(input, {
    provider: req.provider,
    store,
    dispatch: (id) => { if (inProcess) void deliverToCodex(store, id, deps).catch(() => undefined); else spawnDeliveryRunner(runnerEntry, id, env); },
    collect: () => { collectCodexResults(store, deps); },
    lastAnswer: (i) => lastClaudeAnswer(i, env),
    answerBack: (id) => { if (inProcess) void pushAnswerToCodex(store, id, deps).catch(() => undefined); else spawnDeliveryRunner(runnerEntry, id, env, "answer"); },
  });
  return result ? JSON.stringify(result) : "";
}
