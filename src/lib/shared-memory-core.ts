import { createHash } from "node:crypto";
import { redactSession } from "./session-redaction";

export const FREE_WORKSPACE_MEMORY_BYTES = 10 * 1024 * 1024;
export const MEMORY_NOTE_MAX_BYTES = 64 * 1024;
export function normalizeMemoryNote(raw: unknown): { title: string; body: string; contentHash: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Memory note must be an object.");
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 160) throw new Error("Memory title must be 1–160 characters.");
  if (typeof value.body !== "string" || !value.body.trim() || Buffer.byteLength(value.body, "utf8") > MEMORY_NOTE_MAX_BYTES) throw new Error("Memory note must contain 1–64 KiB of text.");
  const title = redactSession(value.title.trim()).redactedText;
  const body = redactSession(value.body.trim()).redactedText;
  if (title.length > 160 || Buffer.byteLength(body, "utf8") > MEMORY_NOTE_MAX_BYTES) throw new Error("Redacted memory exceeds the title or text limit.");
  return { title, body, contentHash: createHash("sha256").update(`${title}\n${body}`).digest("hex") };
}
export function memoryAllowance(usedBytes: number, limitBytes = FREE_WORKSPACE_MEMORY_BYTES) {
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || !Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error("Invalid memory accounting.");
  return { usedBytes, limitBytes, remainingBytes: Math.max(0, limitBytes - usedBytes), limitReached: usedBytes >= limitBytes };
}
