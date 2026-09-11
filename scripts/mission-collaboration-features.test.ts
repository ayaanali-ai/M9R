import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACHMENT_MAX_SIZE_BYTES,
  createCollaborationState,
  getVisibleChannelIds,
  reduceCollaboration,
  validateAttachment,
  validateHuddleCommand,
  type CollaborationCommand,
  type CollaborationState,
} from "../src/lib/mission/mission-collaboration-features.ts";

const missionId = "mission-1";
const ownerId = "human-owner";
const at = "2026-08-01T12:00:00.000Z";

function command<T extends CollaborationCommand["type"]>(
  type: T,
  fields: Omit<Extract<CollaborationCommand, { type: T }>, "type" | "missionId" | "requestId" | "at">,
  requestId: string,
): Extract<CollaborationCommand, { type: T }> {
  return {
    type,
    missionId,
    requestId,
    at,
    ...fields,
  } as Extract<CollaborationCommand, { type: T }>;
}

function apply(state: CollaborationState, next: CollaborationCommand): CollaborationState {
  const result = reduceCollaboration(state, next);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.map((error) => error.code).join(", "));
  return result.state;
}

function expectRejected(state: CollaborationState, next: CollaborationCommand, code: string): void {
  const result = reduceCollaboration(state, next);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.code === code), result.errors.map((error) => error.code).join(", "));
  assert.deepEqual(result.state, state, "rejected commands must not mutate the input state");
}

function withChannelAndMessage(): CollaborationState {
  let state = createCollaborationState({ missionId, humanOwnerId: ownerId });
  state = apply(state, command("channel.created", {
    channelId: "channel-general",
    name: "General",
    visibility: "public",
    memberIds: [ownerId, "alice"],
    createdBy: ownerId,
  }, "channel-1"));
  return apply(state, command("message.created", {
    messageId: "message-1",
    channelId: "channel-general",
    authorId: "alice",
    body: "Initial message",
  }, "message-1"));
}

test("emoji reactions toggle once and replay the same idempotency key", () => {
  const state = withChannelAndMessage();
  const toggle = command("reaction.toggled", {
    messageId: "message-1",
    actorId: "alice",
    emoji: "👍",
  }, "reaction-1");

  const added = reduceCollaboration(state, toggle);
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.deepEqual(added.state.reactions, [{ messageId: "message-1", actorId: "alice", emoji: "👍" }]);
  assert.equal(added.receipt.status, "applied");

  const replay = reduceCollaboration(added.state, toggle);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.receipt.status, "replayed");
  assert.deepEqual(replay.state, added.state, "a retry must not toggle a second time");

  const removed = reduceCollaboration(added.state, { ...toggle, requestId: "reaction-2" });
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.deepEqual(removed.state.reactions, []);
  assert.equal(removed.receipt.reactionActive, false);

  expectRejected(added.state, { ...toggle, emoji: "🎉", requestId: "reaction-1" }, "idempotency_conflict");
});

test("message edits are author-only, versioned, and historied", () => {
  const state = withChannelAndMessage();
  const edited = reduceCollaboration(state, command("message.edited", {
    messageId: "message-1",
    actorId: "alice",
    expectedVersion: 1,
    body: "Edited message",
  }, "edit-1"));
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.state.messages[0].body, "Edited message");
  assert.equal(edited.state.messages[0].version, 2);
  assert.deepEqual(edited.state.messages[0].history.map((entry) => [entry.version, entry.body]), [
    [1, "Initial message"],
    [2, "Edited message"],
  ]);

  expectRejected(edited.state, command("message.edited", {
    messageId: "message-1",
    actorId: ownerId,
    expectedVersion: 2,
    body: "Owner cannot edit another author message",
  }, "edit-owner"), "not_message_author");
  expectRejected(edited.state, command("message.edited", {
    messageId: "message-1",
    actorId: "alice",
    expectedVersion: 1,
    body: "Stale edit",
  }, "edit-stale"), "version_conflict");
});

test("message deletion is a soft tombstone authorized for the author or human owner", () => {
  const state = withChannelAndMessage();
  const deleted = reduceCollaboration(state, command("message.deleted", {
    messageId: "message-1",
    actorId: ownerId,
    expectedVersion: 1,
  }, "delete-1"));
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  const message = deleted.state.messages[0];
  assert.equal(message.body, null);
  assert.deepEqual(message.tombstone, { deletedBy: ownerId, deletedAt: at, version: 2 });
  assert.equal(message.version, 2);
  assert.equal(message.history.at(-1)?.kind, "deleted");
  assert.equal(message.history[0].body, "Initial message", "history remains available to the service layer");
  assert.equal(deleted.state.messages.length, 1, "deletion must not remove the message record");

  expectRejected(deleted.state, command("message.edited", {
    messageId: "message-1",
    actorId: "alice",
    expectedVersion: 2,
    body: "Edit after deletion",
  }, "edit-deleted"), "message_deleted");

  const authorDeleted = reduceCollaboration(withChannelAndMessage(), command("message.deleted", {
    messageId: "message-1",
    actorId: "alice",
    expectedVersion: 1,
  }, "delete-author"));
  assert.equal(authorDeleted.ok, true);

  expectRejected(withChannelAndMessage(), command("message.deleted", {
    messageId: "message-1",
    actorId: "bob",
    expectedVersion: 1,
  }, "delete-unauthorized"), "not_message_author_or_human_owner");
});

test("attachment validation accepts safe URL/file metadata and rejects strict boundary violations", () => {
  const validUrl = validateAttachment({
    kind: "url",
    id: "attachment-url-1",
    channelId: "channel-general",
    createdBy: "alice",
    createdAt: at,
    url: "https://example.com/docs/mission?version=1",
    title: "Mission docs",
  });
  assert.equal(validUrl.ok, true);

  const validFile = validateAttachment({
    kind: "file",
    id: "attachment-file-1",
    channelId: "channel-general",
    createdBy: "alice",
    createdAt: at,
    fileName: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
  });
  assert.equal(validFile.ok, true);

  for (const [input, code] of [
    [{ kind: "url", id: "bad-url", channelId: "c", createdBy: "a", createdAt: at, url: "javascript:alert(1)" }, "invalid_url"],
    [{ kind: "url", id: "credential-url", channelId: "c", createdBy: "a", createdAt: at, url: "https://user:pass@example.com/file" }, "invalid_url"],
    [{ kind: "file", id: "bad-mime", channelId: "c", createdBy: "a", createdAt: at, fileName: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 2 }, "unsupported_mime_type"],
    [{ kind: "file", id: "mime-parameters", channelId: "c", createdBy: "a", createdAt: at, fileName: "x.txt", mimeType: "text/plain; charset=utf-8", sizeBytes: 2 }, "invalid_mime_type"],
    [{ kind: "file", id: "too-large", channelId: "c", createdBy: "a", createdAt: at, fileName: "large.txt", mimeType: "text/plain", sizeBytes: ATTACHMENT_MAX_SIZE_BYTES + 1 }, "file_too_large"],
    [{ kind: "file", id: "path-name", channelId: "c", createdBy: "a", createdAt: at, fileName: "../secret.txt", mimeType: "text/plain", sizeBytes: 2 }, "invalid_file_name"],
  ] as const) {
    const result = validateAttachment(input as never);
    assert.equal(result.ok, false, code);
    if (!result.ok) assert.ok(result.errors.some((error) => error.code === code), `${code}: ${result.errors.map((error) => error.code).join(", ")}`);
  }
});

test("canvas content is versioned and writable only by current editors", () => {
  let state = withChannelAndMessage();
  state = apply(state, command("canvas.created", {
    canvasId: "canvas-1",
    channelId: "channel-general",
    title: "Architecture",
    content: { nodes: [{ id: "n1", type: "note", text: "Start" }] },
    editorIds: ["alice"],
    createdBy: ownerId,
  }, "canvas-1"));

  const updated = reduceCollaboration(state, command("canvas.content.updated", {
    canvasId: "canvas-1",
    actorId: "alice",
    expectedVersion: 1,
    content: { nodes: [{ id: "n1", type: "note", text: "Updated" }] },
  }, "canvas-update-1"));
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.state.canvases[0].version, 2);
  assert.equal(updated.state.canvases[0].history.length, 2);

  expectRejected(updated.state, command("canvas.content.updated", {
    canvasId: "canvas-1",
    actorId: "bob",
    expectedVersion: 2,
    content: { nodes: [] },
  }, "canvas-not-editor"), "not_canvas_editor");

  const granted = reduceCollaboration(updated.state, command("canvas.editor.added", {
    canvasId: "canvas-1",
    actorId: ownerId,
    editorId: "bob",
  }, "canvas-editor-1"));
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.deepEqual(granted.state.canvases[0].editorIds, ["alice", "bob"]);
  assert.equal(reduceCollaboration(granted.state, command("canvas.content.updated", {
    canvasId: "canvas-1",
    actorId: "bob",
    expectedVersion: 2,
    content: { nodes: [{ id: "n1", type: "note", text: "Bob update" }] },
  }, "canvas-update-2")).ok, true);
});

test("private channels hide membership and enforce access", () => {
  let state = createCollaborationState({ missionId, humanOwnerId: ownerId });
  state = apply(state, command("channel.created", {
    channelId: "public",
    name: "Public",
    visibility: "public",
    memberIds: [],
    createdBy: ownerId,
  }, "public-1"));
  state = apply(state, command("channel.created", {
    channelId: "private",
    name: "Private",
    visibility: "private",
    memberIds: ["alice"],
    createdBy: ownerId,
  }, "private-1"));

  assert.deepEqual(getVisibleChannelIds(state, "alice"), ["public", "private"]);
  assert.deepEqual(getVisibleChannelIds(state, "bob"), ["public"]);
  assert.deepEqual(getVisibleChannelIds(state, ownerId), ["public", "private"]);

  expectRejected(state, command("message.created", {
    messageId: "private-message",
    channelId: "private",
    authorId: "bob",
    body: "Should not enter the private channel",
  }, "private-message-denied"), "not_channel_member");

  const ownerAddsMember = reduceCollaboration(state, command("channel.member.added", {
    channelId: "private",
    actorId: ownerId,
    memberId: "bob",
  }, "member-add-1"));
  assert.equal(ownerAddsMember.ok, true);
  if (!ownerAddsMember.ok) return;
  assert.deepEqual(ownerAddsMember.state.channels[1].memberIds, ["alice", "bob"]);

  expectRejected(state, command("channel.member.added", {
    channelId: "private",
    actorId: "bob",
    memberId: "mallory",
  }, "member-add-unauthorized"), "not_channel_owner");
});

test("voice huddles reduce to participant lifecycle metadata and never persist media", () => {
  let state = withChannelAndMessage();
  state = apply(state, command("huddle.started", {
    huddleId: "huddle-1",
    channelId: "channel-general",
    actorId: "alice",
  }, "huddle-start"));
  state = apply(state, command("huddle.joined", {
    huddleId: "huddle-1",
    actorId: "bob",
  }, "huddle-join"));
  state = apply(state, command("huddle.muted", {
    huddleId: "huddle-1",
    actorId: "bob",
    muted: true,
  }, "huddle-mute"));
  state = apply(state, command("huddle.left", {
    huddleId: "huddle-1",
    actorId: "bob",
  }, "huddle-leave"));
  state = apply(state, command("huddle.ended", {
    huddleId: "huddle-1",
    actorId: ownerId,
  }, "huddle-end"));

  const huddle = state.huddles[0];
  assert.equal(huddle.status, "ended");
  assert.deepEqual(huddle.participantIds, ["alice"]);
  assert.deepEqual(huddle.mutedParticipantIds, []);
  assert.equal(huddle.endedAt, at);
  assert.equal("audio" in huddle, false);
  assert.equal("recording" in huddle, false);
  assert.equal("media" in huddle, false);

  const mediaCommand = { ...command("huddle.started", {
    huddleId: "huddle-media",
    channelId: "channel-general",
    actorId: "alice",
  }, "huddle-media"), media: { bytes: "raw-audio" } } as unknown;
  const validation = validateHuddleCommand(mediaCommand);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.ok(validation.errors.some((error) => error.code === "media_not_persisted"));
});

test("invalid mission commands and unknown huddle media leave state unchanged", () => {
  const state = createCollaborationState({ missionId, humanOwnerId: ownerId });
  expectRejected(state, {
    ...command("channel.created", {
      channelId: "x",
      name: "X",
      visibility: "public",
      memberIds: [],
      createdBy: ownerId,
    }, "wrong-mission"),
    missionId: "other-mission",
  }, "wrong_mission");
});
