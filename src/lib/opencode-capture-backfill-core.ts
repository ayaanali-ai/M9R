/**
 * Recovery for OpenCode sessions whose process disappeared before the M9R
 * plugin observed `session.idle`.
 *
 * OpenCode persists sessions locally and exposes two supported CLI operations
 * for reading them: `session list --format json` and `export <id>`. The
 * resident invokes those operations with `--pure`, so recovery is local-only,
 * does not authenticate with a provider, and does not load the M9R plugin
 * recursively. OpenCode's optional `--sanitize` export mode replaces ordinary
 * transcript text with opaque redaction tokens in the current release; M9R
 * therefore preserves useful text and applies its own secret redaction in the
 * existing drainer. Recovered exports enter that spool, and the normal
 * drainer remains the single writer of memory markdown.
 */

import { execFile } from "node:child_process";
import { appendFile, access, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";

import {
  captureMemoryPath,
  normalizeOpenCodeExport,
  parseSpoolLine,
  spoolPath,
  type CaptureJob,
} from "@/lib/cross-agent-capture-core";

const execFileAsync = promisify(execFile);
const CURSOR_FILE_NAME = "opencode-backfill.json";
const DEFAULT_MAX_COUNT = 100;
const DEFAULT_INTERVAL_MS = 60_000;

export interface OpenCodeSessionSummary {
  id: string;
  directory: string;
  updated: number;
  created?: number;
  title?: string;
}

export interface OpenCodeCommandResult {
  stdout: string;
  stderr: string;
}

export type OpenCodeCommandRunner = (args: string[], cwd: string) => Promise<OpenCodeCommandResult>;

export interface OpenCodeBackfillResult {
  scanned: number;
  queued: number;
  skipped: number;
  failed: number;
}

type CursorEntry = {
  updated: number;
  state: "queued" | "captured" | "empty";
};

type BackfillCursor = {
  version: 1;
  lastScannedUpdated: number;
  sessions: Record<string, CursorEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Finds the first balanced JSON object/array in CLI output. OpenCode prints a
 * human-readable `Exporting session: ...` line before export JSON in the
 * current release, and future releases may add similar diagnostics. Parsing
 * only the balanced value keeps those messages out of captured memory.
 */
function extractFirstJsonValue(text: string): unknown | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const opening = text[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === opening) depth += 1;
      else if (character === closing) depth -= 1;
      if (depth !== 0) continue;
      try {
        return JSON.parse(text.slice(start, index + 1)) as unknown;
      } catch {
        break;
      }
    }
  }
  return null;
}

export function parseOpenCodeSessionListOutput(raw: string): OpenCodeSessionSummary[] {
  const parsed = extractFirstJsonValue(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value): OpenCodeSessionSummary[] => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.directory !== "string" || !value.directory) return [];
    const updated = typeof value.updated === "number" ? value.updated : Number(value.updated);
    if (!Number.isFinite(updated)) return [];
    const created = typeof value.created === "number" ? value.created : Number(value.created);
    return [{
      id: value.id,
      directory: value.directory,
      updated,
      ...(Number.isFinite(created) ? { created } : {}),
      ...(typeof value.title === "string" ? { title: value.title } : {}),
    }];
  });
}

export function parseOpenCodeExportOutput(raw: string): Record<string, unknown> | null {
  const parsed = extractFirstJsonValue(raw);
  return isRecord(parsed) ? parsed : null;
}

export function opencodeBackfillCursorPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), ".oathlock", "capture", CURSOR_FILE_NAME);
}

function defaultRunOpenCodeCommand(): OpenCodeCommandRunner {
  return async (args, cwd) => {
    const result = await execFileAsync("opencode", args, {
      cwd,
      shell: process.platform === "win32",
      // Without this, every `opencode session list`/`export` (one per session, every minute) opens
      // a visible console window on Windows.
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };
}

async function loadCursor(repositoryRoot: string): Promise<BackfillCursor> {
  try {
    const parsed = JSON.parse(await readFile(opencodeBackfillCursorPath(repositoryRoot), "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sessions)) throw new Error("invalid cursor");
    const sessions: Record<string, CursorEntry> = {};
    for (const [id, value] of Object.entries(parsed.sessions)) {
      if (!isRecord(value)) continue;
      const updated = Number(value.updated);
      if (!Number.isFinite(updated) || !["queued", "captured", "empty"].includes(String(value.state))) continue;
      sessions[id] = { updated, state: value.state as CursorEntry["state"] };
    }
    return {
      version: 1,
      lastScannedUpdated: Number.isFinite(Number(parsed.lastScannedUpdated)) ? Number(parsed.lastScannedUpdated) : 0,
      sessions,
    };
  } catch {
    return { version: 1, lastScannedUpdated: 0, sessions: {} };
  }
}

async function saveCursor(repositoryRoot: string, cursor: BackfillCursor): Promise<void> {
  const path = opencodeBackfillCursorPath(repositoryRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cursor, null, 2) + "\n", "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRepositoryPath(repositoryRoot: string, candidate: string): boolean {
  const root = resolve(repositoryRoot);
  const target = resolve(candidate);
  const remainder = relative(root, target);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

async function pendingOpenCodeSessionIds(repositoryRoot: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const raw = await readFile(spoolPath(repositoryRoot), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const job = parseSpoolLine(line);
      if (job?.provider === "opencode") ids.add(job.sessionId);
    }
  } catch {
    /* no spool yet, or a transient read failure; the next scan can retry */
  }
  return ids;
}

function isMissingCommand(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * Lists recent local OpenCode sessions, exports only sessions belonging to
 * this repository, and appends recoverable sessions to the existing spool.
 * The cursor is deliberately a per-session ledger rather than a destructive
 * high-water mark: an entry is retried whenever neither a memory file nor a
 * pending spool job proves that capture made it through.
 */
export async function backfillOpenCodeCapture(options: {
  repositoryRoot: string;
  runCommand?: OpenCodeCommandRunner;
  maxCount?: number;
  onLog?: (message: string) => void;
  nowMs?: number;
}): Promise<OpenCodeBackfillResult> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const runCommand = options.runCommand ?? defaultRunOpenCodeCommand();
  const log = options.onLog ?? ((message: string) => console.log(`[cross-agent-capture] ${message}`));
  const maxCount = Math.max(1, Math.min(500, Math.floor(options.maxCount ?? DEFAULT_MAX_COUNT)));
  const cursor = await loadCursor(repositoryRoot);
  const pendingIds = await pendingOpenCodeSessionIds(repositoryRoot);
  const result: OpenCodeBackfillResult = { scanned: 0, queued: 0, skipped: 0, failed: 0 };
  let cursorChanged = false;

  let listOutput: OpenCodeCommandResult;
  try {
    listOutput = await runCommand(["session", "list", "--format", "json", "--max-count", String(maxCount), "--pure", "--log-level", "ERROR"], repositoryRoot);
  } catch (error) {
    if (!isMissingCommand(error)) {
      result.failed = 1;
      log(`OpenCode session recovery could not list local sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  const sessions = parseOpenCodeSessionListOutput(listOutput.stdout);
  for (const session of sessions) {
    if (!isRepositoryPath(repositoryRoot, session.directory)) continue;
    result.scanned += 1;
    const memoryPath = captureMemoryPath(repositoryRoot, {
      provider: "opencode",
      sessionId: session.id,
      cwd: session.directory,
      capturedAtIso: new Date(session.updated || options.nowMs || Date.now()).toISOString(),
      export: {},
    });
    const prior = cursor.sessions[session.id];
    if (await fileExists(memoryPath)) {
      if (!prior || prior.updated !== session.updated || prior.state !== "captured") {
        cursor.sessions[session.id] = { updated: session.updated, state: "captured" };
        cursorChanged = true;
      }
      result.skipped += 1;
      continue;
    }
    if (pendingIds.has(session.id)) {
      if (!prior || prior.updated !== session.updated || prior.state !== "queued") {
        cursor.sessions[session.id] = { updated: session.updated, state: "queued" };
        cursorChanged = true;
      }
      result.skipped += 1;
      continue;
    }
    // An unchanged empty export is not a recoverable session yet. If the
    // session later receives a prompt, OpenCode's updated timestamp changes
    // and it naturally leaves this fast path.
    if (prior?.updated === session.updated && prior.state === "empty") {
      result.skipped += 1;
      continue;
    }

    let exportOutput: OpenCodeCommandResult;
    try {
      exportOutput = await runCommand(["export", session.id, "--pure", "--log-level", "ERROR"], session.directory);
      const exported = parseOpenCodeExportOutput(exportOutput.stdout);
      if (!exported) throw new Error("OpenCode export did not contain JSON");
      const exportedId = isRecord(exported.info) && typeof exported.info.id === "string" ? exported.info.id : null;
      if (exportedId && exportedId !== session.id) throw new Error("OpenCode export session id did not match the listed session");
      if (normalizeOpenCodeExport(exported).length === 0) {
        cursor.sessions[session.id] = { updated: session.updated, state: "empty" };
        cursorChanged = true;
        result.skipped += 1;
        continue;
      }

      const job: CaptureJob = {
        provider: "opencode",
        sessionId: session.id,
        cwd: session.directory,
        capturedAtIso: new Date(options.nowMs ?? Date.now()).toISOString(),
        export: exported,
      };
      const path = spoolPath(repositoryRoot);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(job) + "\n", "utf8");
      pendingIds.add(session.id);
      cursor.sessions[session.id] = { updated: session.updated, state: "queued" };
      cursorChanged = true;
      result.queued += 1;
    } catch (error) {
      result.failed += 1;
      log(`OpenCode session recovery failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const newestUpdated = sessions.reduce((max, session) => Math.max(max, session.updated), cursor.lastScannedUpdated);
  if (newestUpdated !== cursor.lastScannedUpdated) {
    cursor.lastScannedUpdated = newestUpdated;
    cursorChanged = true;
  }
  if (cursorChanged) await saveCursor(repositoryRoot, cursor);
  if (result.queued > 0) log(`queued ${result.queued} OpenCode session recovery job(s)`);
  return result;
}

/** Started with the capture drainer so a resident restart recovers sessions even when OpenCode is not running. */
export function startOpenCodeCaptureBackfillLoop(options: { repositoryRoot: string; intervalMs?: number }): void {
  const tick = () => {
    void backfillOpenCodeCapture({ repositoryRoot: options.repositoryRoot }).catch(() => {
      /* recovery is best-effort and must never take down the resident */
    });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
}
