/**
 * Hook-free Codex mentions: read what Codex itself writes to its rollout file and notice a person's typed `@agent` prompt
 * without any hook (and so without the one-time `/hooks` trust step). Pure functions only; codex-watch.ts does the I/O.
 *
 * A typed prompt is a user message with exactly one text part that directly follows a `turn_context` record. Everything
 * Codex injects (AGENTS.md text, environment blocks, ambient UI state, sub-agent history) either has several parts,
 * starts with a tag, or follows something else. Sub-agent sessions (source is an object) are never watched.
 */
import { isM9rPushedPrompt } from "./codex-delivery-core";

export interface WatchFile {
  /** Bytes already consumed (always ends on a newline). */
  offset: number;
  /** Type of the previous record, to spot a user message that starts a turn. */
  prev: string;
  id?: string;
  cwd?: string;
  /** True for sessions we must never route from (sub-agents such as the approval guardian). */
  skip?: boolean;
  /** The turn of a forwarded mention that is still running, so double work can be flagged. */
  turn?: { taskId: string; worked: boolean };
}

export type WatchEvent = { kind: "prompt"; text: string } | { kind: "work" } | { kind: "turn_end" };

export const newWatchFile = (offset: number): WatchFile => ({ offset, prev: "" });

const partsText = (content: unknown): string | null => {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const part = content[0] as { type?: string; text?: unknown };
  return part?.type === "input_text" && typeof part.text === "string" ? part.text : null;
};

/** Consumes complete lines from `chunk`, updates `file` and returns what happened. A trailing partial line is left for next time. */
export function consumeRollout(chunk: string, file: WatchFile): { events: WatchEvent[]; consumedChars: number } {
  const events: WatchEvent[] = [];
  const cut = chunk.lastIndexOf("\n");
  if (cut < 0) return { events, consumedChars: 0 };
  for (const line of chunk.slice(0, cut).split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; payload?: { type?: string; role?: string; content?: unknown; id?: string; cwd?: string; source?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }
    const type = rec.type ?? "";
    const p = rec.payload ?? {};
    if (type === "session_meta") {
      file.id = typeof p.id === "string" ? p.id : file.id;
      file.cwd = typeof p.cwd === "string" ? p.cwd : file.cwd;
      if (p.source !== null && typeof p.source === "object") file.skip = true;
    } else if (type === "response_item" && p.type === "message" && p.role === "user") {
      const text = partsText(p.content);
      const typed = text !== null && file.prev === "turn_context" && text.trim() !== "" && !/^\s*[<#]/.test(text) && !isM9rPushedPrompt(text);
      if (typed && !file.skip) events.push({ kind: "prompt", text: text! });
    } else if (type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      events.push({ kind: "work" });
    } else if (type === "event_msg" && p.type === "task_complete") {
      events.push({ kind: "turn_end" });
    }
    file.prev = type;
  }
  return { events, consumedChars: cut + 1 };
}
