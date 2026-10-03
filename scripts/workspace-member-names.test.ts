import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// Confirmed live: the "Who can join" picker, the Settings team list, and chat presence avatars all showed a teammate's
// raw email (or user id) because /api/workspace/members and the chat roster endpoint never returned a resolved name.
test("workspace members carry a resolved name, never only an email or id, in the service and every client that reads it", () => {
  const service = read("src/lib/workspace-membership-service.ts");
  assert.match(service, /personLabel\(/, "listWorkspaceMembers resolves a display name");
  assert.match(service, /name: string;/, "WorkspaceMember exposes a name field");

  const switcher = read("src/components/product/ChannelSwitcher.tsx");
  assert.doesNotMatch(switcher, /member\.email \?\? member\.userId/);
  assert.match(switcher, /const label = member\.name;/);

  const settings = read("src/components/product/SettingsView.tsx");
  assert.doesNotMatch(settings, /\{member\.email \?\? member\.userId\}/);
  assert.match(settings, /member\.userId === viewerUserId \? "You" : member\.name/);

  const panel = read("src/components/product/ConversationPanel.tsx");
  assert.doesNotMatch(panel, /row\.email \?\? row\.userId/);
  assert.match(panel, /row\.userId === viewerUserId \? "You" : row\.name/);
});
