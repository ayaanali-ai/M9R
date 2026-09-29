import assert from "node:assert/strict";
import test from "node:test";
import { createRoomRelayCore, type RoomRelayResult } from "../src/lib/native/room-relay-core.ts";

function errorOf(result: RoomRelayResult): string {
  return result.ok ? "" : result.error;
}

test("room relay keeps requested members quiet until owner admission, then relays ordered events", () => {
  const relay = createRoomRelayCore({ newId: (() => { let n = 0; return () => `event-${++n}`; })() });
  assert.equal(relay.create("room-1", "owner").ok, true);
  assert.equal(relay.requestJoin("room-1", "guest", "owner-b").ok, true);
  const quiet: unknown[] = [];
  assert.equal(relay.attach("room-1", "guest", (event) => quiet.push(event)), null);
  assert.equal(relay.publish("room-1", "owner", { kind: "message", payload: "before admission" }).ok, true);
  assert.equal(quiet.length, 0);
  assert.equal(relay.admit("room-1", "owner", "guest").ok, true);
  const received: string[] = [];
  const detach = relay.attach("room-1", "guest", (event) => received.push(`${event.sequence}:${event.payload}`));
  assert.ok(detach);
  assert.equal(relay.publish("room-1", "owner", { kind: "message", payload: "after admission" }).ok, true);
  assert.deepEqual(received, ["2:after admission"]);
});

test("room relay refuses spoofed admission, replayed IDs, and removed members", () => {
  const relay = createRoomRelayCore({ newId: () => "event-1" });
  relay.create("room-2", "owner");
  relay.requestJoin("room-2", "guest", "owner-b");
  assert.match(errorOf(relay.admit("room-2", "guest", "guest")), /owner/);
  assert.equal(relay.admit("room-2", "owner", "guest").ok, true);
  assert.equal(relay.publish("room-2", "owner", { eventId: "event-1", kind: "presence", payload: "x" }).ok, true);
  assert.match(errorOf(relay.publish("room-2", "owner", { eventId: "event-1", kind: "presence", payload: "x" })), /replayed/);
  assert.equal(relay.remove("room-2", "owner", "guest").ok, true);
  assert.match(errorOf(relay.publish("room-2", "guest", { kind: "message", payload: "x" })), /active room membership/);
});

test("the replay-guard set is capped so a long-running room does not grow it forever, at the cost of only remembering the most recent event ids", () => {
  let n = 0;
  const relay = createRoomRelayCore({ newId: () => `event-${++n}` });
  relay.create("room-cap", "owner");
  for (let i = 0; i < 5_010; i += 1) assert.equal(relay.publish("room-cap", "owner", { kind: "presence", payload: "x" }).ok, true);
  // A very old event id has aged out of the cap and is treated as new again (an acceptable trade-off for bounded memory).
  assert.equal(relay.publish("room-cap", "owner", { eventId: "event-1", kind: "presence", payload: "x" }).ok, true);
  // A recent one is still caught as a replay.
  assert.match(errorOf(relay.publish("room-cap", "owner", { eventId: "event-5010", kind: "presence", payload: "x" })), /replayed/);
});
