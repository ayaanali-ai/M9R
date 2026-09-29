import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRoomEvent } from "../src/lib/rooms/room-events.ts";
import { projectRoomArtifacts } from "../src/lib/rooms/room-artifacts.ts";

const eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("room posts keep only bounded, explicit shared text and structural reply metadata", () => {
  const result = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "post",
    payload: {
      text: "  Let's check the checkout page.  ",
      recipientActorId: "member:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      replyTo: taskId,
      pageText: "private page contents must never enter the room log",
      token: "must not be stored",
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.payload, {
    type: "message",
    text: "Let's check the checkout page.",
    recipientActorId: "member:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    replyTo: taskId,
  });
  assert.equal(result.value.clientEventId, eventId);
  assert.match(result.value.payloadDigest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result.value).includes("private page contents"));
  assert.ok(!JSON.stringify(result.value).includes("must not be stored"));
});

test("shared task events validate and bound the goal and done criteria", () => {
  const result = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "task",
    payload: {
      type: "created",
      taskId,
      title: "Review the signup flow",
      goal: "Find where the invite flow can lose the member identity.",
      doneCriteria: ["Identify the failing transition", "Add a regression test"],
      status: "open",
      debugDump: "not allowed",
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.payload, {
    type: "created",
    taskId,
    title: "Review the signup flow",
    goal: "Find where the invite flow can lose the member identity.",
    doneCriteria: ["Identify the failing transition", "Add a regression test"],
    status: "open",
  });

  assert.equal(normalizeRoomEvent({ clientEventId: eventId, kind: "task", payload: { type: "created", taskId, title: "" } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: eventId, kind: "task", payload: { type: "created", taskId, title: "x", goal: "g", doneCriteria: ["x".repeat(501)] } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: eventId, kind: "task", payload: { type: "completed", taskId, status: "open" } }).ok, false);
  const completed = normalizeRoomEvent({ clientEventId: eventId, kind: "task", payload: { type: "completed", taskId } });
  assert.equal(completed.ok && completed.value.payload.status, "done");
});

test("handoff events carry explicit recipient, context, and completion criteria", () => {
  const result = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "handoff",
    payload: {
      type: "proposed",
      handoffId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      taskId,
      recipientActorId: "member:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      context: "The auth route accepts the invite, but the room page still shows requested.",
      doneCriteria: ["Find why the refreshed membership view is stale"],
      secret: "must not leave the sender's context",
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payload.type, "proposed");
  assert.equal(result.value.payload.taskId, taskId);
  assert.deepEqual(result.value.payload.doneCriteria, ["Find why the refreshed membership view is stale"]);
  assert.equal("secret" in result.value.payload, false);
});

test("shared artifacts are bounded snapshots with optimistic-version ancestry", () => {
  const artifactId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const created = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "artifact",
    payload: { type: "created", artifactId, title: "Decision notes", content: "First draft" },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.value.payload, { type: "created", artifactId, title: "Decision notes", content: "First draft" });
  assert.equal(normalizeRoomEvent({ clientEventId: taskId, kind: "artifact", payload: { type: "created", artifactId, title: "x", content: "y", pageText: "not shareable" } }).ok, false);

  const updated = normalizeRoomEvent({
    clientEventId: taskId,
    kind: "artifact",
    causalEventIds: [eventId],
    payload: { type: "updated", artifactId, baseEventId: eventId, title: "Decision notes", content: "Revised draft" },
  });
  assert.equal(updated.ok, true);
  assert.equal(normalizeRoomEvent({
    clientEventId: taskId,
    kind: "artifact",
    payload: { type: "updated", artifactId, baseEventId: eventId, title: "Decision notes", content: "unlinked base" },
  }).ok, false, "an edit must causally name the exact artifact version it replaces");
  assert.equal(normalizeRoomEvent({
    clientEventId: taskId,
    kind: "artifact",
    payload: { type: "updated", artifactId, baseEventId: eventId, title: "Decision notes", content: "unlinked base" },
  }).ok, false, "an edit must causally name the exact artifact version it replaces");
  assert.equal(normalizeRoomEvent({ clientEventId: taskId, kind: "artifact", payload: { type: "updated", artifactId, title: "Decision notes", content: "lost update" } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: taskId, kind: "artifact", payload: { type: "created", artifactId, title: "x", content: "y", extra: "not shareable" } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: taskId, kind: "artifact", payload: { type: "created", artifactId, title: "x", content: "x".repeat(8_001) } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: taskId, kind: "artifact", payload: { type: "created", artifactId, title: "x", content: "💬".repeat(2_049) } }).ok, false, "the UTF-8 byte limit applies to multibyte content too");

  const projected = projectRoomArtifacts([
    { id: eventId, kind: "artifact", sequence: 1, payload: created.value.payload },
    { id: taskId, kind: "artifact", sequence: 2, payload: updated.ok ? updated.value.payload : {} },
  ]);
  assert.deepEqual(projected, [{ id: artifactId, title: "Decision notes", content: "Revised draft", eventId: taskId, sequence: 2 }]);
});

test("stored presence is rejected because presence is ephemeral, while malformed identities are refused", () => {
  assert.equal(normalizeRoomEvent({ clientEventId: eventId, kind: "presence", payload: {} }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: "not-a-uuid", kind: "post", payload: { text: "hi" } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: eventId, kind: "post", payload: { text: "x".repeat(4001) } }).ok, false);
  assert.equal(normalizeRoomEvent({ clientEventId: eventId, kind: "post", payload: { text: "hi", pageText: "drop" }, causalEventIds: ["bad-id"] }).ok, false);
});

test("authoritative decisions and machine-action receipts cannot be forged through the generic event writer", () => {
  for (const kind of ["approval", "disclosure", "intent", "membership"]) {
    const result = normalizeRoomEvent({
      clientEventId: eventId,
      kind,
      payload: { type: "approved", decision: "approve", summary: "looks authoritative" },
    });
    assert.equal(result.ok, false, `${kind} must use its state-checked endpoint`);
    if (!result.ok) assert.match(result.error, /purpose-built authority workflow/i);
  }

  const forgedAction = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "action",
    payload: { type: "agent.action", action: "click", summary: "pretend an action ran" },
  });
  assert.equal(forgedAction.ok, false);

  const confirmedTarget = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "action",
    payload: {
      type: "shared_target.confirmed",
      owner_confirmed: true,
      target: { pageGroupId: "pg-shared", origin: "https://shop.example", path: "/cart", tabRef: "tab-a" },
    },
  });
  assert.equal(confirmedTarget.ok, true, "the narrow shared-target confirmation remains supported");
  const agentTargetConfirmation = normalizeRoomEvent({
    clientEventId: eventId,
    kind: "action",
    actorSeatId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    payload: {
      type: "shared_target.confirmed",
      owner_confirmed: true,
      target: { pageGroupId: "pg-shared", origin: "https://shop.example", path: "/cart", tabRef: "tab-a" },
    },
  });
  assert.equal(agentTargetConfirmation.ok, true, "the owner may confirm a shared page on behalf of an active, room-bound agent seat");
});
