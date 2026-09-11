export interface WorkspaceCursor {
  createdAt: string;
  messageId: string;
}

const CURSOR_PREFIX = "workspace-cursor.v1:";

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{1,128}$/i.test(value);
}

export function encodeWorkspaceCursor(cursor: WorkspaceCursor): string {
  if (!isIsoTimestamp(cursor.createdAt) || !isMessageId(cursor.messageId)) {
    throw new Error("Workspace cursor is invalid.");
  }
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

/**
 * Decode the current tuple cursor. ISO timestamps from the pre-Phase-1
 * protocol remain readable as a compatibility cursor; they intentionally
 * have an empty message id and may replay one boundary row, but cannot skip
 * a same-timestamp row.
 */
export function decodeWorkspaceCursor(value: string | null | undefined): WorkspaceCursor | null {
  if (typeof value !== "string" || !value) return null;
  if (isIsoTimestamp(value)) return { createdAt: value, messageId: "" };
  if (!value.startsWith(CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as Partial<WorkspaceCursor>;
    const createdAt = parsed.createdAt;
    const messageId = parsed.messageId;
    if (typeof createdAt !== "string" || !isIsoTimestamp(createdAt) || !isMessageId(messageId)) return null;
    return { createdAt, messageId };
  } catch {
    return null;
  }
}

export function workspaceCursorFromMessage(message: { created_at: string; id: string }): string {
  return encodeWorkspaceCursor({ createdAt: message.created_at, messageId: message.id });
}

export function compareWorkspaceCursor(left: WorkspaceCursor, right: WorkspaceCursor): number {
  const createdAtComparison = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtComparison !== 0) return createdAtComparison < 0 ? -1 : 1;
  if (!left.messageId || !right.messageId) return 0;
  return left.messageId === right.messageId ? 0 : left.messageId.toLowerCase() < right.messageId.toLowerCase() ? -1 : 1;
}

export function cursorIsAfter(cursor: WorkspaceCursor, message: { created_at: string; id: string }): boolean {
  return compareWorkspaceCursor({ createdAt: message.created_at, messageId: message.id }, cursor) > 0;
}
