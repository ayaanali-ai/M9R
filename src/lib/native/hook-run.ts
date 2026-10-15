/**
 * One hook call, as a function: given the event JSON an agent sent, return the text the hook prints. Used by the small hook
 * program (`m9r-hook.js`) and by the resident engine's hook server, so there is a single copy of the logic.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalStore, defaultStoreRoot, handleForProvider } from "./local-store";
import { handleHookEvent, type HookInput } from "./hook-handler";
import { collectCodexResults, deliverToCodex, pushAnswerToCodex, realDeps, spawnDeliveryRunner } from "./codex-delivery";
import { createWebBrokerClient } from "./web-broker-client";
import { brokerKeyPath } from "./web-broker-paths";
import { prepareHookInboxTaskStageNotice } from "./task-stage-notice";

export interface HookRequest {
  event: string;
  provider: string;
  input: HookInput | null;
  /** Original stdin wire payload; populated only by the standalone m9r-hook entrypoint. */
  rawPayload?: string;
  /** Only the few settings the hook reads (M9R_HOME, CODEX_HOME, PATH...); the caller's own environment, not the server's. */
  env?: Record<string, string | undefined>;
}

const RAW_MENTION_CAPTURE_MARKER = "capture-next-raw-mention";
const RAW_MENTION_CAPTURE_LOG = "mention-hook-payloads.jsonl";
const MAX_RAW_MENTION_RECORD_BYTES = 64 * 1024;
const MAX_RAW_MENTION_LOG_BYTES = 4 * 1024 * 1024;

/** Arm one bounded, one-shot local capture of the next Claude mention-triggering hook. */
export function armRawMentionHookCapture(root: string): boolean {
  const directory = join(root, "diagnostics");
  const marker = join(directory, RAW_MENTION_CAPTURE_MARKER);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return false;
  }
}

/** Consume an arm marker atomically and preserve the exact wire payload without printing it. */
export function captureArmedRawMentionPayloadOnce(
  root: string,
  provider: string,
  targets: readonly string[],
  rawPayload: string | undefined,
  at = new Date().toISOString(),
): boolean {
  if (provider !== "claude-code" || targets.length === 0 || typeof rawPayload !== "string") return false;
  const directory = join(root, "diagnostics");
  const marker = join(directory, RAW_MENTION_CAPTURE_MARKER);
  const claim = `${marker}.claim-${randomUUID()}`;
  try { renameSync(marker, claim); } catch { return false; }
  try {
    const record = JSON.stringify({ at, provider, targets: [...targets], rawPayload });
    const recordBytes = Buffer.byteLength(record, "utf8") + 1;
    if (recordBytes > MAX_RAW_MENTION_RECORD_BYTES) return false;
    const logPath = join(directory, RAW_MENTION_CAPTURE_LOG);
    const previousBytes = existsSync(logPath) ? statSync(logPath).size : 0;
    if (previousBytes + recordBytes > MAX_RAW_MENTION_LOG_BYTES) return false;
    appendFileSync(logPath, `${record}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(claim); } catch { /* already consumed */ }
  }
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
export async function runHookRequest(req: HookRequest, runnerEntry: string, baseEnv: Record<string, string | undefined> = process.env, inProcess = false): Promise<string> {
  const env = { ...baseEnv, ...(req.env ?? {}) };
  const root = defaultStoreRoot(homedir(), env);
  const store = createLocalStore(root);
  const deps = realDeps(env);
  const input: HookInput = { ...(req.input ?? {}) };
  if (!input.hook_event_name && req.event) input.hook_event_name = req.event;
  const web = createWebBrokerClient({ keyPath: brokerKeyPath(root), port: Number(env.M9R_WEB_BROKER_PORT) || undefined });
  // Task-stage setup is opt-in and local. Keep it below the provider's hook budget; if the broker is slow,
  // the normal inbox path still succeeds and the agent can prepare the stage through MCP on its next check.
  const stageNotice = await prepareHookInboxTaskStageNotice({
    root,
    store,
    web,
    handle: handleForProvider(req.provider),
    event: input.hook_event_name ?? req.event,
    sessionId: input.session_id,
    cwd: input.cwd,
    prompt: input.prompt,
    timeoutMs: 2_000,
  });
  const result = handleHookEvent(input, {
    provider: req.provider,
    store,
    rawPayload: req.rawPayload,
    strictTargetIdentity: true,
    // Opt-in, bounded local evidence for the phantom mention bug. The raw provider payload is
    // needed to compare what the hook received with the user's visible prompt; never print it.
    captureMentionInput: (parsed, targets, rawPayload) => {
      if (env.M9R_CAPTURE_MENTION_PAYLOAD === "1") {
        const directory = join(root, "diagnostics");
        const path = join(directory, RAW_MENTION_CAPTURE_LOG);
        if (!existsSync(path) || statSync(path).size <= MAX_RAW_MENTION_LOG_BYTES) {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const record = JSON.stringify({ at: new Date().toISOString(), provider: req.provider, targets, raw: parsed });
          if (Buffer.byteLength(record, "utf8") <= MAX_RAW_MENTION_RECORD_BYTES) appendFileSync(path, `${record}\n`, { encoding: "utf8", mode: 0o600 });
        }
      }
      captureArmedRawMentionPayloadOnce(root, req.provider, targets, rawPayload);
    },
    dispatch: (id) => { if (inProcess) void deliverToCodex(store, id, deps).catch(() => undefined); else spawnDeliveryRunner(runnerEntry, id, env); },
    collect: () => { collectCodexResults(store, deps); },
    lastAnswer: (i) => lastClaudeAnswer(i, env),
    answerBack: (id) => { if (inProcess) void pushAnswerToCodex(store, id, deps).catch(() => undefined); else spawnDeliveryRunner(runnerEntry, id, env, "answer"); },
  });
  // A Stop hook is the only authoritative native-session completion signal. Wait for the local broker to publish it
  // before this hook process/pipe request exits; a fire-and-forget fetch can be abandoned as the provider shuts down.
  if ((input.hook_event_name ?? req.event) === "Stop" && input.session_id) {
    try { await web.markDone?.(handleForProvider(req.provider), req.provider, input.session_id); } catch { /* best effort; never fail a provider turn because the optional overlay could not be updated */ }
  }
  if (stageNotice && result) result.hookSpecificOutput.additionalContext += `\n\n${stageNotice}`;
  return result ? JSON.stringify(result) : "";
}
