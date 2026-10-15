import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ownedBrowserLaunch, selectPersonalBrowserWindow } from "../src/lib/native/task-stage-apps";

test("personal browser launch uses the user's profile and asks Chrome for a new window", () => {
  const app = { executable: join("browser", "chrome.exe"), args: [] };
  const first = ownedBrowserLaunch("root", "preview-agent-0123456789abcdef01234567", app);
  const second = ownedBrowserLaunch("root", "preview-agent-1123456789abcdef01234567", app);
  assert.deepEqual(first.args, ["--new-window"]);
  assert.deepEqual(second.args, ["--new-window"]);
  assert.deepEqual(app.args, []);
  const explicit = { ...app, args: ["--owner-configured"] };
  assert.equal(ownedBrowserLaunch("root", "agent-0123456789abcdef01234567", explicit), explicit);
  assert.throws(() => ownedBrowserLaunch("root", "../escape", app), /Invalid browser stage/);
});

test("isolated browser mode remains an explicit opt-in", () => {
  const app = { executable: join("browser", "chrome.exe"), args: [] };
  const isolated = ownedBrowserLaunch("root", "agent-0123456789abcdef01234567", app, { mode: "isolated" });
  assert.match(isolated.args[0]!, /stage-browser-profiles/);
  assert.equal(isolated.args.at(-1), "about:blank");
});

test("personal browser adoption chooses only a newly-created Chrome window", () => {
  const before = new Set(["100:0x10"]);
  const candidate = { pid: 100, windowId: "0x11", appName: "chrome.exe", title: "New Tab" };
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [candidate], before), candidate);
  assert.equal(selectPersonalBrowserWindow("chrome", [{ ...candidate, windowId: "0x10" }], before), undefined);
  assert.throws(() => selectPersonalBrowserWindow("chrome", [candidate, { ...candidate, windowId: "0x12" }], before), /multiple new windows/);
  assert.equal(selectPersonalBrowserWindow("chrome", [{ ...candidate, appName: "msedge.exe" }], new Set()), undefined);
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [{ ...candidate, appName: "Chrome_WidgetWin_1" }], new Set()), { ...candidate, appName: "Chrome_WidgetWin_1" });
});
