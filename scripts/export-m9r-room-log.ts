import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { M9R_ENV_PREFIX, LEGACY_ENV_PREFIX } from "../src/lib/native/m9r-compatibility";

type StoredMessage = {
  id?: unknown;
  sender_connection_id?: unknown;
  sender_user_id?: unknown;
  kind?: unknown;
  body?: unknown;
  parent_message_id?: unknown;
  created_at?: unknown;
};

const [roomId, outputFlag, outputPath] = process.argv.slice(2);
if (!roomId || (outputFlag !== undefined && (outputFlag !== "--out" || !outputPath))) {
  throw new Error("Usage: npx tsx scripts/export-m9r-room-log.ts <room-id> [--out <new-file.json>]");
}
const tokenFile = [".m9r/agents/codex/local.json", ".oathlock/agents/codex/local.json"].find((path) => {
  try { return Boolean(JSON.parse(readFileSync(path, "utf8")).token); }
  catch { return false; }
});
if (!tokenFile) throw new Error("No local Codex M9R connection file was found.");
const token = JSON.parse(readFileSync(tokenFile, "utf8")).token as string;
if (typeof token !== "string" || !token) throw new Error("The local Codex connection file has no token.");
const suffix = "API_URL";
const apiUrl = (process.env[`${M9R_ENV_PREFIX}${suffix}`] ?? process.env[`${LEGACY_ENV_PREFIX}${suffix}`] ?? "https://m9r.dev").replace(/\/+$/, "");
const response = await fetch(`${apiUrl}/api/agent/conversations/${encodeURIComponent(roomId)}/messages`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`Room export failed with HTTP ${response.status}; the token may not be a room member.`);
const responseBody = await response.json() as { messages?: unknown };
if (!Array.isArray(responseBody.messages)) throw new Error("Room message endpoint returned an invalid response.");
const events = (responseBody.messages as StoredMessage[]).map((message, index) => {
  const actorKind = typeof message.sender_connection_id === "string" ? "agent" : "human";
  const actorId = typeof message.sender_connection_id === "string"
    ? message.sender_connection_id
    : typeof message.sender_user_id === "string" ? message.sender_user_id : "unknown-human";
  return {
    eventId: typeof message.id === "string" ? message.id : `export-${index}-${randomUUID()}`,
    roomId,
    sequence: index + 1,
    actorId,
    actorKind,
    type: "room.message",
    ...(typeof message.kind === "string" ? { messageKind: message.kind } : {}),
    ...(typeof message.parent_message_id === "string" ? { parentMessageId: message.parent_message_id } : {}),
    ...(typeof message.created_at === "string" ? { createdAt: message.created_at } : {}),
    ...(typeof message.body === "string" ? { body: message.body } : {}),
  };
});
const output = {
  schema: "m9r.room-log/0",
  roomId,
  exportedAt: new Date().toISOString(),
  source: "authenticated conversation message history",
  traceCoverage: "messages-only",
  pageGroups: [],
  events,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (outputPath) {
  const absolutePath = resolve(outputPath);
  if (existsSync(absolutePath)) throw new Error(`Refusing to overwrite existing export: ${absolutePath}`);
  writeFileSync(absolutePath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`Exported ${events.length} room messages to ${absolutePath}. This message-only export cannot prove coordinated actions.\n`);
} else {
  process.stdout.write(serialized);
}
