import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HEARTBEAT_FRAME_TYPE, LEASE_SWEEP_INTERVAL_MS, PRESENCE_LEASE_MS, anyHeartbeating, expiredHeartbeatingConnections } from "../services/relay-do/src/lease";

const NOW = 1_000_000;
const conn = (id: string, heartbeating: boolean, silentMs: number) => ({ id, heartbeating, lastInboundAt: NOW - silentMs });

test("the lease matches the locked presence rule: 90 seconds, swept every 30", () => {
  assert.equal(PRESENCE_LEASE_MS, 90_000);
  assert.equal(LEASE_SWEEP_INTERVAL_MS, 30_000);
  assert.equal(HEARTBEAT_FRAME_TYPE, "bridge.heartbeat");
});

test("a heartbeating Bridge is expired only after a full lease of silence, exactly at the boundary", () => {
  const connections = [conn("fresh", true, 5_000), conn("edge", true, PRESENCE_LEASE_MS), conn("over", true, PRESENCE_LEASE_MS + 1), conn("ancient", true, 10 * 60_000)];
  assert.deepEqual(expiredHeartbeatingConnections(connections, NOW).map((c) => c.id), ["over", "ancient"]);
});

test("a socket that never heartbeated (a browser tab) is never swept, however quiet", () => {
  assert.deepEqual(expiredHeartbeatingConnections([conn("tab", false, 24 * 3600_000)], NOW), []);
});

test("any inbound frame refreshes the lease, so an active Bridge is never closed mid-work", () => {
  const busy = { id: "busy", heartbeating: true, lastInboundAt: NOW - 10_000 };
  assert.deepEqual(expiredHeartbeatingConnections([busy], NOW), []);
});

test("the sweeper only needs to run while something is heartbeating", () => {
  assert.equal(anyHeartbeating([conn("a", false, 0), conn("b", false, 0)]), false);
  assert.equal(anyHeartbeating([conn("a", false, 0), conn("b", true, 0)]), true);
  assert.equal(anyHeartbeating([]), false);
});

test("the Hub marks a socket as heartbeating only after auth, refreshes on every frame, and closes with 4009 without holding an idle timer", () => {
  const src = readFileSync("services/relay-do/src/hub.ts", "utf8");
  assert.match(src, /conn\.authed && \(parsed as \{ type\?: unknown \} \| null\)\?\.type === HEARTBEAT_FRAME_TYPE/, "an unauthenticated socket cannot opt itself into (or out of) the lease by sending a heartbeat");
  assert.match(src, /conn\.lastInboundAt = now;/);
  assert.match(src, /closeSocket\(conn, 4009, "presence_lease_expired"\)/);
  assert.match(src, /clearInterval\(this\.leaseSweeper\)/, "the interval is cleared once no heartbeating Bridge remains");
  assert.match(src, /if \(this\.leaseSweeper\) return;/, "one interval per Hub");
});
