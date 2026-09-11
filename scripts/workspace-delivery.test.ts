import assert from "node:assert/strict";
import test from "node:test";
import {
  compareWorkspaceCursor,
  cursorIsAfter,
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
  workspaceCursorFromMessage,
} from "@/lib/mission/workspace-cursor";

const createdAt = "2026-08-10T12:00:00.000Z";

test("workspace cursors preserve timestamp and message id across encode/decode", () => {
  const cursor = encodeWorkspaceCursor({ createdAt, messageId: "00000000-0000-0000-0000-000000000001" });
  assert.equal(cursor.startsWith("workspace-cursor.v1:"), true);
  assert.deepEqual(decodeWorkspaceCursor(cursor), { createdAt, messageId: "00000000-0000-0000-0000-000000000001" });
});

test("workspace cursors advance messages sharing the same timestamp by id", () => {
  const cursor = decodeWorkspaceCursor(workspaceCursorFromMessage({ created_at: createdAt, id: "00000000-0000-0000-0000-000000000010" }));
  assert.ok(cursor);
  assert.equal(cursorIsAfter(cursor, { created_at: createdAt, id: "00000000-0000-0000-0000-000000000011" }), true);
  assert.equal(cursorIsAfter(cursor, { created_at: createdAt, id: "00000000-0000-0000-0000-000000000010" }), false);
  assert.equal(cursorIsAfter(cursor, { created_at: createdAt, id: "00000000-0000-0000-0000-000000000009" }), false);
});

test("workspace cursors order timestamps before ids", () => {
  assert.equal(compareWorkspaceCursor(
    { createdAt: "2026-08-10T12:00:01.000Z", messageId: "00000000-0000-0000-0000-000000000001" },
    { createdAt, messageId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
  ), 1);
});

test("legacy ISO cursors remain readable without claiming a message id", () => {
  assert.deepEqual(decodeWorkspaceCursor(createdAt), { createdAt, messageId: "" });
  assert.equal(decodeWorkspaceCursor("not-a-cursor"), null);
});
