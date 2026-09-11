import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");

test("mission bridge uses one authenticated relay client for mission and workspace traffic", () => {
  assert.equal((source.match(/new MissionRelayClient\(/g) ?? []).length, 1);
  assert.match(source, /const workspaceRelayClient = relayClient/);
  assert.match(source, /handleRelayFrame\(frame\);[\s\S]*?handleWorkspaceRelayFrame\(frame\)/);
});

/**
 * The synthetic "X received this and is starting now" chat message was
 * removed: it was a hardcoded template, never model output, and real
 * research into Buzz's own agent-chat platform (block/buzz's base_prompt.md)
 * confirmed their design explicitly forbids posting a bare acknowledgement
 * at all. The signal it existed for -- "is this mention actually being
 * worked on, especially once a turn runs for minutes" -- already has a real,
 * dedicated answer that didn't get wired to replace it until now:
 * setWorkspaceTyping, refreshed on a heartbeat for the whole turn and
 * rendered as a proper "X is typing..." indicator in the channel, plus the
 * sidebar's live presence state.
 */
test("no synthetic acknowledgement message is posted before a turn's real reply", () => {
  assert.doesNotMatch(source, /postWorkspaceAck/);
  assert.doesNotMatch(source, /received this and is starting now/);
});

test("a real 'is typing' indicator, refreshed for the whole turn, replaces the old ack message", () => {
  const start = source.indexOf("let typingHeartbeat: ReturnType<typeof setInterval> | null = null;");
  const end = source.indexOf("const promptCallStartedAt = new Date();", start);
  assert.ok(start >= 0 && end > start, "typing-indicator setup block must remain explicit");
  const block = source.slice(start, end);
  assert.match(block, /setWorkspaceTyping\(\{ channelId: conversationId, participantId, typing: true \}\)/);
  // Refreshed on an interval so a long provider turn stays visibly active
  // instead of the relay's 2.5s typing expiry making it look stalled.
  assert.match(block, /typingHeartbeat = setInterval\(/);
});

test("postedOwnMessageSince no longer needs an ack id to exclude -- it's always called with null", () => {
  assert.match(source, /postedOwnMessageSince\(conversationId, promptCallStartedAt, null\)/);
});
