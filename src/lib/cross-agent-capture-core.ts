/**
 * Cross-agent session capture — M9R_MASTER_BUILD_PLAN.md item #35.
 * ----------------------------------------------------------------------------
 * Captures work from a coding-agent CLI a human launched THEMSELVES (Claude
 * Code, Codex, OpenCode run directly in their own terminal, never touching
 * M9R's dashboard) into the same `.oathlock/memory/` pipeline
 * memory-export-core.ts already built for M9R's own dashboard sessions.
 * Verified research (2026-09) found real, officially documented, per-repo
 * hook/plugin mechanisms for all three providers -- no raw private-file
 * scraping needed as the *trigger*, though Claude Code's actual transcript
 * content still has to come from its JSONL file (its own docs point a
 * SessionEnd hook at exactly that file via `transcript_path`, while warning
 * the line-level schema is internal and can drift between releases -- this
 * module treats that as a defensive-parsing requirement, not a blocker: skip
 * lines that don't match, never assume a closed schema, never throw).
 *
 * Architecture: capture -> spool -> drain, because two of the three
 * providers give a hook well under two seconds to react, non-blocking, with
 * Codex hard-capping at 3s. Whatever runs INSIDE the hook (see
 * scripts/m9r-capture-hook.mjs) must do the absolute minimum -- append one
 * JSON line to `.oathlock/capture/pending.jsonl` and exit. Everything in
 * this file is the slow half: read later, by the already-running resident,
 * with no time pressure.
 *
 * Redaction is not optional here. `memory-export-core.ts` was safe to render
 * verbatim while its only source was M9R's own dashboard chat; a real
 * terminal transcript routinely contains `.env` reads and pasted
 * credentials, so every message body here goes through the same
 * `session-redaction.ts` this repo already built for exactly this problem,
 * with heuristics on.
 */

import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { redactSession } from "@/lib/session-redaction";

export const CAPTURE_DIR_NAME = "capture";
export const SPOOL_FILE_NAME = "pending.jsonl";
export const ERROR_LOG_FILE_NAME = "errors.log";

export type CaptureProvider = "claude-code" | "codex" | "opencode";

/**
 * One line of `.oathlock/capture/pending.jsonl`. Claude Code and Codex spool
 * a pointer to their own on-disk transcript (their SessionEnd hook payloads
 * are field-identical enough to share this shape); OpenCode's plugin is not
 * time-boxed the way a SessionEnd hook is, so it spools the already-fetched
 * structured export directly rather than a path, per the research's explicit
 * recommendation (the drainer would otherwise need OpenCode's own server URL
 * to fetch it after the fact, from a separate process, after the session may
 * already be gone).
 */
export type CaptureJob =
  | {
      provider: "claude-code" | "codex";
      sessionId: string;
      transcriptPath: string;
      cwd: string;
      reason: string;
      capturedAtIso: string;
    }
  | {
      provider: "opencode";
      sessionId: string;
      cwd: string;
      capturedAtIso: string;
      /** The raw `{ info, messages: [{ info, parts }] }` shape opencode's own SDK/export CLI produces. */
      export: unknown;
    };

export interface CaptureTranscriptMessage {
  sender: string;
  body: string;
}

/**
 * Stable content identity shared by local capture and dashboard-exported
 * memory. Sender labels are intentionally excluded: a local transcript says
 * `User`/`Assistant`, while a dashboard transcript says a person's/provider's
 * display name. Requiring two substantive messages keeps a short repeated
 * greeting from collapsing unrelated sessions by accident.
 */
export function transcriptFingerprint(transcript: Array<{ sender: string; body: string }>): string | null {
  const bodies = transcript
    .filter((message) => typeof message?.body === "string" && message.body.trim())
    .map((message) => message.body.replace(/\r\n?/g, "\n").trim());
  if (bodies.length < 2 || bodies.join("\n").length < 32) return null;
  return createHash("sha256").update(JSON.stringify(bodies)).digest("hex");
}

const MEMORY_FINGERPRINT_PATTERN = /<!--\s*m9r-memory-fingerprint:([0-9a-f]{64})\s*-->/i;

/** Reads the marker emitted by either memory writer, with a fallback parser for files created before item #4. */
export function fingerprintFromMemoryMarkdown(markdown: string): string | null {
  const marker = markdown.match(MEMORY_FINGERPRINT_PATTERN)?.[1];
  if (marker) return marker.toLowerCase();

  const messages: CaptureTranscriptMessage[] = [];
  let sender: string | null = null;
  let bodyLines: string[] = [];
  const flush = () => {
    if (sender && bodyLines.join("\n").trim()) messages.push({ sender, body: bodyLines.join("\n").trim() });
    sender = null;
    bodyLines = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const header = line.match(/^\*\*(.+):\*\*$/);
    if (header) {
      flush();
      sender = header[1];
      continue;
    }
    if (sender) bodyLines.push(line);
  }
  flush();
  return transcriptFingerprint(messages);
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listMarkdownFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files;
}

/** Finds an identical transcript already stored by the other memory path. */
export async function findMemoryFingerprintMatch(options: {
  repositoryRoot: string;
  fingerprint: string;
  excludePath?: string;
}): Promise<string | null> {
  const root = join(resolve(options.repositoryRoot), ".oathlock", "memory");
  const excluded = options.excludePath ? resolve(options.excludePath) : null;
  for (const path of await listMarkdownFiles(root)) {
    if (excluded && resolve(path).toLowerCase() === excluded.toLowerCase()) continue;
    try {
      const markdown = await readFile(path, "utf8");
      if (fingerprintFromMemoryMarkdown(markdown) === options.fingerprint.toLowerCase()) return path;
    } catch {
      /* a file removed during the scan is not a dedup failure */
    }
  }
  return null;
}

/** One line in, one job or null out. Never throws -- a malformed spool line must never crash the drain loop or take down the rest of the batch. */
export function parseSpoolLine(line: string): CaptureJob | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const provider = record.provider;
  if (provider !== "claude-code" && provider !== "codex" && provider !== "opencode") return null;
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  if (typeof record.cwd !== "string") return null;
  if (typeof record.capturedAtIso !== "string") return null;

  if (provider === "opencode") {
    return {
      provider,
      sessionId: record.sessionId,
      cwd: record.cwd,
      capturedAtIso: record.capturedAtIso,
      export: record.export,
    };
  }
  if (typeof record.transcriptPath !== "string" || !record.transcriptPath) return null;
  return {
    provider,
    sessionId: record.sessionId,
    transcriptPath: record.transcriptPath,
    cwd: record.cwd,
    reason: typeof record.reason === "string" ? record.reason : "other",
    capturedAtIso: record.capturedAtIso,
  };
}

/**
 * Claude Code's JSONL transcript, parsed defensively. Real, documented
 * hazards (per research against community parsers, since Anthropic's own
 * docs only warn the schema is internal, not what specifically drifts): new
 * fields get added between releases, and a resumed/rewound session can
 * rewrite an already-written record, so the same `uuid` can appear more than
 * once -- last write wins. Only text content and tool NAMES are extracted
 * (never tool arguments or file diffs -- that is where both schema drift and
 * secret leakage concentrate, an explicit v1 scope cut).
 */
export function parseClaudeCodeTranscript(jsonlText: string): CaptureTranscriptMessage[] {
  const byUuid = new Map<string, CaptureTranscriptMessage>();
  const order: string[] = [];
  let fallbackIndex = 0;

  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const entry = record as Record<string, unknown>;
    const type = entry.type;
    if (type !== "user" && type !== "assistant") continue;

    const message = entry.message as Record<string, unknown> | undefined;
    const body = extractClaudeCodeMessageText(message);
    if (!body) continue;

    const key = typeof entry.uuid === "string" && entry.uuid ? entry.uuid : `__line_${fallbackIndex++}`;
    if (!byUuid.has(key)) order.push(key);
    byUuid.set(key, { sender: type === "user" ? "User" : "Assistant", body });
  }

  return order.map((key) => byUuid.get(key)!);
}

function extractClaudeCodeMessageText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      parts.push(`[used tool: ${b.name}]`);
    } else if (b.type === "tool_result") {
      parts.push("[tool result omitted]");
    }
  }
  return parts.join("\n").trim();
}

/**
 * Codex's rollout JSONL, parsed defensively. Precise record shapes
 * (`event_msg`/`response_item`/`turn_context`/`compacted`) are confirmed to
 * exist by name but their internal field layout is only community-sourced,
 * not officially documented as stable -- so this scans shallowly for known
 * text-bearing fields rather than assuming one closed schema, and silently
 * skips anything it doesn't recognize.
 */
export function parseCodexTranscript(jsonlText: string): CaptureTranscriptMessage[] {
  const messages: CaptureTranscriptMessage[] = [];
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const entry = record as Record<string, unknown>;

    // response_item-shaped: { type: "response_item", payload: { role, content } | { type: "message", role, content } }
    const payload = (entry.payload ?? entry.item ?? entry) as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractCodexPayloadText(payload.content);
    if (!text) continue;
    messages.push({ sender: role === "user" ? "User" : "Assistant", body: text });
  }
  return messages;
}

function extractCodexPayloadText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * OpenCode's `{ info, messages: [{ info, parts }] }` export shape (the same
 * shape its own `opencode export` CLI produces, per the research's source
 * read) -- the richest of the three inputs, since it's structured data, not
 * a line-oriented private log. Tool call/result parts are named, not
 * rendered in full, matching the same v1 scope cut as the other two parsers.
 */
export function normalizeOpenCodeExport(raw: unknown): CaptureTranscriptMessage[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const entries = Array.isArray(root.messages) ? root.messages : [];
  const out: CaptureTranscriptMessage[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const info = e.info as Record<string, unknown> | undefined;
    const role = info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts = Array.isArray(e.parts) ? e.parts : [];
    const bodyParts: string[] = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        bodyParts.push(p.text);
      } else if (p.type === "tool" && typeof p.tool === "string") {
        bodyParts.push(`[used tool: ${p.tool}]`);
      }
    }
    const body = bodyParts.join("\n").trim();
    if (!body) continue;
    out.push({ sender: role === "user" ? "User" : "Assistant", body });
  }
  return out;
}

/** Dispatches to the right parser for a job's provider. Never throws -- an unparseable transcript yields an empty list, which callers treat as "nothing to write," not an error. */
export function extractTranscript(job: CaptureJob, rawTranscript: string | null): CaptureTranscriptMessage[] {
  try {
    if (job.provider === "opencode") return normalizeOpenCodeExport(job.export);
    if (rawTranscript == null) return [];
    return job.provider === "claude-code" ? parseClaudeCodeTranscript(rawTranscript) : parseCodexTranscript(rawTranscript);
  } catch {
    return [];
  }
}

const PROVIDER_LABEL: Record<CaptureProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** Redacts every message and renders the same markdown shape memory-export-core.ts writes, so search_memory/the Sessions catalog and a plain grep both keep working unchanged for terminal-captured work. */
export function renderCaptureMarkdown(job: CaptureJob, transcript: CaptureTranscriptMessage[]): string {
  const reason = job.provider === "opencode" ? "session finished" : job.reason;
  const fingerprint = transcriptFingerprint(transcript);
  const lines = [
    `# ${PROVIDER_LABEL[job.provider]} session (${job.sessionId.slice(0, 12)})`,
    "",
    `- Provider: ${PROVIDER_LABEL[job.provider]}`,
    `- Captured: ${job.capturedAtIso}`,
    `- Working directory: ${job.cwd}`,
    `- Reason: ${reason}`,
    `- Session id: ${job.sessionId}`,
  ];
  if (fingerprint) lines.push(`<!-- m9r-memory-fingerprint:${fingerprint} -->`);

  const redacted = transcript.map((m) => ({ sender: m.sender, ...redactSession(m.body, { includeHeuristics: true }) }));
  const totalRedactions = redacted.reduce((sum, m) => sum + Object.values(m.countsByType).reduce((a, n) => a + n, 0), 0);
  if (totalRedactions > 0) {
    lines.push(`- Redacted: ${totalRedactions} item(s) across this transcript. Automatic redaction is best-effort, not a guarantee -- review before sharing.`);
  }

  lines.push("", "---", "");
  if (redacted.length === 0) {
    lines.push("_(no message content could be extracted from this session)_", "");
  }
  for (const message of redacted) {
    lines.push(`**${message.sender}:**`, "", message.redactedText, "");
  }
  return lines.join("\n");
}

/** Where a captured session's markdown lands. Deliberately its own "local" bucket, separate from `<owner>/<channel>` (dashboard sessions) -- this work never touched an M9R channel, so it has no owner/channel identity to file under. */
export function captureMemoryPath(repositoryRoot: string, job: CaptureJob): string {
  return join(repositoryRoot, ".oathlock", "memory", "local", job.provider, `${job.sessionId}.md`);
}

function captureDir(repositoryRoot: string): string {
  return resolve(repositoryRoot, ".oathlock", CAPTURE_DIR_NAME);
}
export function spoolPath(repositoryRoot: string): string {
  return join(captureDir(repositoryRoot), SPOOL_FILE_NAME);
}
function errorLogPath(repositoryRoot: string): string {
  return join(captureDir(repositoryRoot), ERROR_LOG_FILE_NAME);
}

export interface DrainCaptureSpoolOptions {
  repositoryRoot: string;
  /** Reads a job's transcript file (Claude Code/Codex only). Injected so tests never touch a real filesystem path outside their own temp dir. */
  readTranscript: (path: string) => Promise<string>;
  onLog?: (message: string) => void;
}

/**
 * Drains every pending job: parse -> redact -> write markdown. Runs from the
 * resident's own export loop (no time pressure, unlike the hook that wrote
 * the job). A job that fails (unreadable transcript file, for instance) is
 * logged and dropped, never retried forever and never left to crash the
 * whole batch -- the spool is a best-effort inbox, not a queue with delivery
 * guarantees, matching how the hook that writes it can't tell if it worked.
 */
export async function drainCaptureSpool(options: DrainCaptureSpoolOptions): Promise<{ drained: number; failed: number }> {
  const path = spoolPath(options.repositoryRoot);
  const log = options.onLog ?? ((message: string) => console.log(`[cross-agent-capture] ${message}`));
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { drained: 0, failed: 0 };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { drained: 0, failed: 0 };

  let drained = 0;
  let failed = 0;
  let deduped = 0;
  const prepared = new Map<string, { job: CaptureJob; transcript: CaptureTranscriptMessage[]; markdown: string; fingerprint: string | null }>();
  for (const line of lines) {
    const job = parseSpoolLine(line);
    if (!job) {
      failed += 1;
      continue;
    }
    try {
      const rawTranscript = job.provider === "opencode" ? null : await options.readTranscript(job.transcriptPath);
      const transcript = extractTranscript(job, rawTranscript);
      const markdown = renderCaptureMarkdown(job, transcript);
      const fingerprint = transcriptFingerprint(transcript);
      const key = `${job.provider}:${job.sessionId}`;
      const existing = prepared.get(key);
      const messageSize = transcript.reduce((sum, message) => sum + message.body.length, 0);
      const existingSize = existing?.transcript.reduce((sum, message) => sum + message.body.length, 0) ?? -1;
      if (existing) deduped += 1;
      if (!existing || transcript.length > existing.transcript.length || (transcript.length === existing.transcript.length && messageSize >= existingSize)) {
        prepared.set(key, { job, transcript, markdown, fingerprint });
      }
    } catch (error) {
      failed += 1;
      await logCaptureFailure(options.repositoryRoot, job, error);
    }
  }

  for (const { job, markdown, fingerprint } of prepared.values()) {
    try {
      const outPath = captureMemoryPath(options.repositoryRoot, job);
      const duplicate = fingerprint
        ? await findMemoryFingerprintMatch({ repositoryRoot: options.repositoryRoot, fingerprint, excludePath: outPath })
        : null;
      if (!duplicate) {
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, markdown, "utf8");
      } else deduped += 1;
      drained += 1;
    } catch (error) {
      failed += 1;
      await logCaptureFailure(options.repositoryRoot, job, error);
    }
  }

  // Best-effort inbox: clear the spool once every line has been attempted,
  // success or failure -- a spool that only ever grows is a slow leak, and a
  // job this repo genuinely can't process (a transcript file already
  // deleted, say) will never become processable by being retried forever.
  await writeFile(path, "", "utf8").catch(() => undefined);
  if (drained > 0 || failed > 0) log(`drained ${drained} captured session(s)${deduped > 0 ? `, ${deduped} duplicate(s) skipped` : ""}${failed > 0 ? `, ${failed} failed` : ""}`);
  return { drained, failed };
}

async function logCaptureFailure(repositoryRoot: string, job: CaptureJob, error: unknown): Promise<void> {
  await mkdir(captureDir(repositoryRoot), { recursive: true }).catch(() => undefined);
  await appendFile(
    errorLogPath(repositoryRoot),
    `${new Date().toISOString()} ${job.provider} ${job.sessionId}: ${error instanceof Error ? error.message : String(error)}\n`,
    "utf8",
  ).catch(() => undefined);
}

/** Started once per machine, alongside startMemoryExportLoop, from `m9r-cli terminal runtime`. */
export function startCaptureDrainLoop(options: { repositoryRoot: string; intervalMs?: number }): void {
  const intervalMs = options.intervalMs ?? 60_000;
  const tick = () => {
    void drainCaptureSpool({ repositoryRoot: options.repositoryRoot, readTranscript: (p) => readFile(p, "utf8") }).catch(() => {
      /* logged inside; never crash the runtime over a drain blip */
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
}
