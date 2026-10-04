import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// Confirmed live: the @mention menu (ConversationPanel.tsx, z-index 2147483000) sat under the extension's presence
// overlay (presence-overlay.js, z-index 2147483647 on document.documentElement), which caught its clicks. The dashboard
// already has its own chat UI, so the overlay now skips mounting on dashboard pages instead of fighting them for layering.
test("the dashboard marks its own pages, and the extension skips the presence overlay there", () => {
  const layout = read("src/app/dashboard/layout.tsx");
  assert.match(layout, /data-m9r-app-shell/);

  const content = read("extensions/browser/src/content.js");
  assert.match(content, /document\.querySelector\("\[data-m9r-app-shell\]"\)/);
  // Must come before the overlay is ever created.
  assert.ok(content.indexOf("data-m9r-app-shell") < content.indexOf("createPresenceOverlay"));
});
