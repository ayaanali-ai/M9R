import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MissionRelayClient } from "../src/lib/mission/mission-relay-client";

const RELAY_URL = "wss://m9r-relay.m9r.workers.dev/";
const APP_URL = "https://m9r.dev";
const tokenFile = [".m9r/agents/codex/local.json", ".oathlock/agents/codex/local.json"].find((path) => {
  try { return Boolean(JSON.parse(readFileSync(path, "utf8")).token); }
  catch { return false; }
});
if (!tokenFile) throw new Error("No local Codex M9R connection file was found.");
const token = JSON.parse(readFileSync(tokenFile, "utf8")).token as string;
if (typeof token !== "string" || token.length === 0) throw new Error("The local Codex connection file has no token.");

async function main(): Promise<void> {
const headers = { authorization: `Bearer ${token}` };
const whoResponse = await fetch(`${APP_URL}/api/agent/whoami`, { headers, signal: AbortSignal.timeout(15_000) });
if (!whoResponse.ok) throw new Error(`Authenticated identity lookup failed with HTTP ${whoResponse.status}.`);
const who = await whoResponse.json() as { workspaceId?: string; connectionId?: string };
if (!who.workspaceId || !who.connectionId) throw new Error("Identity lookup did not return a workspace and connection.");

const roomsResponse = await fetch(`${APP_URL}/api/agent/conversations`, { headers, signal: AbortSignal.timeout(15_000) });
if (!roomsResponse.ok) throw new Error(`Room lookup failed with HTTP ${roomsResponse.status}.`);
const roomsBody = await roomsResponse.json() as { conversations?: Array<{ id?: unknown; status?: unknown; topic?: unknown }> };
const rooms = (roomsBody.conversations ?? []).filter((room): room is { id: string; status?: unknown; topic?: unknown } => typeof room.id === "string" && room.status === "open");
if (rooms.length === 0) throw new Error("No open room is available to use for the live relay test.");
const room = rooms[0]!;

const smokeId = randomUUID();
const body = `M9R relay smoke test ${smokeId} — automated transport check; safe to ignore.`;
const firstFrames: unknown[] = [];
const secondFrames: unknown[] = [];
const makeClient = (suffix: string, frames: unknown[]) => new MissionRelayClient({
  url: RELAY_URL,
  workspaceId: who.workspaceId!,
  credential: token,
  participantId: `${who.connectionId}:${suffix}`,
  connectTimeoutMs: 12_000,
  autoReconnect: false,
  onFrame: (frame) => { frames.push(frame); },
});
const first = makeClient("smoke-a", firstFrames);
const second = makeClient("smoke-b", secondFrames);
const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 12_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!predicate()) throw new Error(`Timed out waiting for ${label}.`);
};
const hasFrameType = (frames: unknown[], type: string): boolean => frames.some((frame) => frame !== null && typeof frame === "object" && "type" in frame && frame.type === type);

try {
  await Promise.all([first.connect(), second.connect()]);
  await Promise.all([first.subscribeWorkspace(room.id), second.subscribeWorkspace(room.id)]);
  await Promise.all([
    waitFor(() => hasFrameType(firstFrames, "workspace.snapshot"), "first client room snapshot"),
    waitFor(() => hasFrameType(secondFrames, "workspace.snapshot"), "second client room snapshot"),
  ]);
  const ack = await first.postWorkspaceMessage({ channelId: room.id, kind: "notice", body, idempotencyKey: `m9r-live-relay-smoke:${smokeId}` });
  await waitFor(() => secondFrames.some((frame) => frame !== null && typeof frame === "object" && "type" in frame && frame.type === "workspace.event" && String(JSON.stringify(frame)).includes(body)), "smoke message at second client");
  process.stdout.write("PASS: authenticated identity lookup returned a workspace and connection.\n");
  process.stdout.write("PASS: two independent authenticated WebSocket clients received relay.ready and room snapshots.\n");
  process.stdout.write("PASS: sender post was acknowledged by the room service.\n");
  process.stdout.write("PASS: the second client received the exact smoke message over the live relay.\n");
  process.stdout.write(`ROOM_ID ${room.id}\n`);
  process.stdout.write(`MESSAGE_ID ${typeof ack.messageId === "string" ? ack.messageId : typeof ack.id === "string" ? ack.id : "acknowledged"}\n`);
  process.stdout.write("LIMIT: both sockets used the same local Codex identity; this does not prove two machines or two owners.\n");
} finally {
  await Promise.all([first.close(), second.close()]);
}
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
