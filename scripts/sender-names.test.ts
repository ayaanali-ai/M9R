import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// An older version stored the literal word "You" as the sender name of 146 human messages. Every other member then saw
// "You" on a message somebody else sent (found when an invited admin opened the workspace).
test("the dashboard never shows a stored 'You' or 'Me' as someone else's name", () => {
  const panel = readFileSync(join(process.cwd(), "src/components/product/ConversationPanel.tsx"), "utf8");
  const raw = panel.split("\n").filter((line) => /\.sender_display_name \?\?/.test(line) && !line.includes("realName"));
  assert.deepEqual(raw, [], "every use of a stored sender name goes through realName()");
  assert.match(panel, /function realName\(/);
});

test("the server replaces placeholder sender names with the real person's name", () => {
  const service = readFileSync(join(process.cwd(), "src/lib/conversation-service.ts"), "utf8");
  assert.match(service, /export function isPlaceholderSenderName/);
  assert.match(service, /\(you\|me\)/i);
  assert.doesNotMatch(service, /\|\| "You";/, "a missing name is never saved as the word You");
});
