import assert from "node:assert/strict";
import test from "node:test";
import { projectRoomEventType } from "../src/lib/rooms/room-event-export.ts";

const seatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const target = { pageGroupId: "pg-shared", origin: "https://shop.example", path: "/cart", tabRef: "tab-a" };

test("exported event type comes from the durable event kind, not untrusted payload.type", () => {
  assert.equal(projectRoomEventType("post", { type: "agent.action" }), "room.message");
  assert.equal(projectRoomEventType("share", { type: "approval", decision: "approved" }), "room.share");
  assert.equal(projectRoomEventType("approval", { type: "approved" }), "room.approval.unverified");
  assert.equal(projectRoomEventType("action", { type: "agent.action" }), "room.action.unverified");
  assert.equal(projectRoomEventType("action", { type: "agent.action", owner_confirmed: true, target }), "room.action.unverified");
});

test("only the narrow owner-confirmed shared target and transactional handoff shapes get trusted projections", () => {
  assert.equal(projectRoomEventType("action", { type: "shared_target.confirmed", owner_confirmed: true, target }), "room.shared_target.confirmed");
  assert.equal(projectRoomEventType("action", { type: "shared_target.confirmed", owner_confirmed: true, target, agentSeatId: seatId }), "room.action.unverified", "actor seat attribution belongs in the event column, never inside the payload");
  assert.equal(projectRoomEventType("handoff", { type: "accepted" }), "room.handoff.unverified");
  assert.equal(projectRoomEventType("handoff", {
    type: "accepted",
    actorId: `seat:${seatId}`,
    senderActorId: `member:${seatId}`,
  }), "room.handoff.accepted");
  assert.equal(projectRoomEventType("task", { type: "completed" }), "room.task.completed");
});
