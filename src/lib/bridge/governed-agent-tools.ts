/**
 * Governed tool implementations, extracted from dev-mcp-server.ts so both
 * that MCP surface (spawned per-session for the ACP-driven providers --
 * Claude Code, Codex, OpenCode) and M9R's own native agent loop (item #32
 * phase 2, which calls these directly in-process since the harness IS the
 * process, no MCP indirection needed) share one real implementation instead
 * of two copies that could silently drift apart.
 *
 * Pure logic only -- no MCP types, no Zod schemas, no z.infer wiring. Each
 * caller (dev-mcp-server.ts's registerTool callbacks, or the native agent
 * loop's AI SDK `tool()` definitions) wraps these in whatever shape its own
 * transport needs.
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve as resolvePath, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // Same cap as Buzz's paths.rs MAX_FILE_BYTES.
export const MAX_RESULT_CHARS = 200_000; // Bounded tool output, consistent with this codebase's evidence/message size limits elsewhere.
export const GIT_READ_TIMEOUT_MS = 10_000;
export const MAX_GIT_READ_LINES = 20;

/** True when `candidate` (an absolute, resolved path) is `root` itself or lies inside it. Pure string/segment comparison on already-resolved paths -- no symlink resolution, matching mission-path-containment.ts's same documented limitation. */
export function containsPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function resolveWithin(root: string, requestedPath: string): string {
  const candidate = resolvePath(root, requestedPath);
  if (!containsPath(root, candidate)) {
    throw new Error(`"${requestedPath}" resolves outside the working directory (${root}) and is refused.`);
  }
  return candidate;
}

export function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated, ${text.length - MAX_RESULT_CHARS} more characters]` : text;
}

export async function readGovernedFile(root: string, path: string): Promise<string> {
  const resolved = resolveWithin(root, path);
  const info = await stat(resolved);
  if (info.size > MAX_FILE_BYTES) throw new Error(`"${path}" is ${info.size} bytes, over the ${MAX_FILE_BYTES}-byte limit.`);
  const content = await readFile(resolved, "utf8");
  return truncate(content);
}

export async function strReplaceGovernedFile(root: string, path: string, oldText: string, newText: string): Promise<string> {
  const resolved = resolveWithin(root, path);
  const content = await readFile(resolved, "utf8");
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) throw new Error(`oldText was not found in "${path}".`);
  if (occurrences > 1) throw new Error(`oldText occurs ${occurrences} times in "${path}"; it must be unique. Include more surrounding context.`);
  await writeFile(resolved, content.replace(oldText, newText), "utf8");
  return `Replaced 1 occurrence in ${path}.`;
}

export async function listGovernedTree(root: string, path: string, maxDepth: number): Promise<string> {
  const resolved = resolveWithin(root, path);
  const lines: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || lines.length > 5_000) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const entryPath = join(dir, entry.name);
      lines.push(`${"  ".repeat(depth - 1)}${relative(root, entryPath).replace(/\\/g, "/")}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) await walk(entryPath, depth + 1);
    }
  }
  await walk(resolved, 1);
  return truncate(lines.join("\n") || "(empty)");
}

export async function ripgrepSearch(root: string, pattern: string, path: string, caseInsensitive: boolean, maxMatches: number): Promise<string> {
  const resolved = resolveWithin(root, path);
  const args = ["--line-number", "--with-filename", "--max-count", String(maxMatches), "--glob", "!node_modules", "--glob", "!.git"];
  if (caseInsensitive) args.push("--ignore-case");
  args.push(pattern, resolved);
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn("rg", args, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolvePromise(stdout); // rg exits 1 on "no matches", not an error here.
      else rejectPromise(new Error(stderr || `rg exited with code ${code}`));
    });
  });
  return truncate(output || "(no matches)");
}

export type GitReadOperation = "status" | "log" | "diff_stat" | "branch";

export function gitReadArgs(operation: GitReadOperation, limit: number): string[] {
  switch (operation) {
    case "status": return ["status", "--short", "--branch"];
    case "log": return ["log", `-${Math.min(Math.max(Math.trunc(limit), 1), MAX_GIT_READ_LINES)}`, "--oneline"];
    case "diff_stat": return ["diff", "--stat", "--"];
    case "branch": return ["branch", "--show-current"];
  }
}

export async function runGitRead(root: string, operation: GitReadOperation, limit: number): Promise<string> {
  const args = gitReadArgs(operation, limit);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const control: { timeout?: ReturnType<typeof setTimeout> } = {};
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (control.timeout) clearTimeout(control.timeout);
      callback();
    };
    const append = (current: string, chunk: Buffer): string => truncate(`${current}${chunk.toString("utf8")}`);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(() => rejectPromise(new Error(`git ${operation} could not start: ${error.message}`))));
    child.once("close", (code, signal) => finish(() => {
      if (code !== 0) {
        const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exited with code ${code}`);
        rejectPromise(new Error(`git ${operation} failed: ${detail}`));
        return;
      }
      resolvePromise(stdout.trim() || "(no output)");
    }));
    control.timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectPromise(new Error(`git ${operation} exceeded the ${GIT_READ_TIMEOUT_MS}ms read-only limit.`)));
    }, GIT_READ_TIMEOUT_MS);
  });
}

export async function gitRead(root: string, operation: GitReadOperation, limit: number): Promise<string> {
  const args = gitReadArgs(operation, limit);
  const output = await runGitRead(root, operation, limit);
  return `git ${args.join(" ")}\n${output}`;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/** Mutates the supplied list in place (the caller owns the list's lifetime -- one per session, same as dev-mcp-server.ts's closure-scoped `todos` array). */
export function todoAction(todos: TodoItem[], action: "list" | "add" | "complete", text?: string, id?: string): string {
  if (action === "add") {
    if (!text?.trim()) throw new Error("text is required for action=add.");
    if (todos.length >= 200) throw new Error("Todo list is at its 200-item bound.");
    const item: TodoItem = { id: crypto.randomUUID(), text: text.trim().slice(0, 500), done: false };
    todos.push(item);
    return `Added ${item.id}: ${item.text}`;
  }
  if (action === "complete") {
    if (!id) throw new Error("id is required for action=complete.");
    const item = todos.find((entry) => entry.id === id);
    if (!item) throw new Error(`No todo with id "${id}".`);
    item.done = true;
    return `Completed ${id}.`;
  }
  return todos.map((item) => `[${item.done ? "x" : " "}] ${item.id}: ${item.text}`).join("\n") || "(no todos)";
}

/**
 * send_message's real HTTP call, extracted verbatim. This is the exact
 * mechanism that makes agent-to-agent messaging identical regardless of
 * which provider/adapter is asking -- Claude Code, Codex, OpenCode, and
 * M9R's own native harness all end up calling this same function against
 * this same route, so the relay and every other agent see an identical
 * message shape no matter which one sent it.
 */
export async function postAgentMessage(channel: { appUrl: string; agentToken: string; missionId: string }, input: {
  text: string;
  parentMessageId?: string;
  recipientConnectionId?: string;
}): Promise<string> {
  const conversationId = channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null;
  if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to post this message.");
  // Generated once per call so a future retry of this exact fetch (not a
  // fresh model-chosen call) replays safely instead of posting twice.
  const idempotencyKey = crypto.randomUUID();
  const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      kind: "message",
      body: input.text,
      ...(input.parentMessageId ? { parent_message_id: input.parentMessageId } : {}),
      ...(input.recipientConnectionId ? { recipient_connection_id: input.recipientConnectionId } : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Could not post the message (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
  return "Message posted to the channel.";
}
