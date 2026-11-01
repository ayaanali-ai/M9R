import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ownedBrowserLaunch, selectExistingPersonalBrowserWindow, selectPersonalBrowserWindow } from "../src/lib/native/task-stage-apps";

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
  assert.equal(selectPersonalBrowserWindow("chrome", [candidate, { ...candidate, windowId: "0x12" }], before)?.windowId, "0x11");
  assert.equal(selectPersonalBrowserWindow("chrome", [{ ...candidate, appName: "msedge.exe" }], new Set()), undefined);
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [{ ...candidate, appName: "Chrome_WidgetWin_1" }], new Set()), { ...candidate, appName: "Chrome_WidgetWin_1" });
});

test("personal browser adoption ignores hidden, minimized, and wrong-desktop helper windows", () => {
  const visible = { pid: 100, windowId: "0x11", appName: "chrome.exe", title: "New Tab", isOnScreen: true, minimized: false, onCurrentSpace: true, width: 1200, height: 800 };
  const helper = { ...visible, windowId: "0x12", isOnScreen: false, title: "Chrome helper" };
  const minimized = { ...visible, windowId: "0x13", minimized: true };
  const otherDesktop = { ...visible, windowId: "0x14", onCurrentSpace: false };
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [helper, minimized, otherDesktop, visible], new Set()), visible);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", [helper, minimized, otherDesktop, visible]), visible);
});
