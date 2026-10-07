import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ownedBrowserLaunch } from "../src/lib/native/task-stage-apps";

test("Chromium stages use separate fixed profiles instead of another window's process", () => {
  const app = { executable: join("browser", "chrome.exe"), args: [], sha256: "unchanged" };
  const first = ownedBrowserLaunch("root", "preview-agent-0123456789abcdef01234567", app);
  const second = ownedBrowserLaunch("root", "preview-agent-1123456789abcdef01234567", app);
  assert.notEqual(first.args[0], second.args[0]);
  assert.equal(first.sha256, app.sha256);
  assert.equal(first.args.at(-1), "about:blank");
  assert.deepEqual(app.args, []);
  const explicit = { ...app, args: ["--owner-configured"] };
  assert.equal(ownedBrowserLaunch("root", "agent-0123456789abcdef01234567", explicit), explicit);
  assert.throws(() => ownedBrowserLaunch("root", "../escape", app), /Invalid browser stage/);
});
