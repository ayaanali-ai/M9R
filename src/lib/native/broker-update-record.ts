import { Buffer } from "node:buffer";

/** Parse an M9R-owned JSON record, accepting legacy UTF-8 files with a BOM. */
export function parseBrokerUpdateRecord(bytes: Buffer | null, label: string): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid record");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`The M9R ${label} ownership record is unreadable; refusing to change the broker process.`);
  }
}
