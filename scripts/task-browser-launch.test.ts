import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { hasAmbiguousExistingPersonalBrowserWindow, isPackageManagerShimPath, ownedBrowserLaunch,
  resolveStageLaunchApp, selectExistingPersonalBrowserWindow, selectPersonalBrowserWindow } from "../src/lib/native/task-stage-apps";

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
  assert.equal(selectPersonalBrowserWindow("chrome", [candidate, { ...candidate, windowId: "0x12" }], before), undefined,
    "two fresh windows are ambiguous and must not be silently retargeted");
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
  assert.equal(selectExistingPersonalBrowserWindow("chrome", [visible, { ...visible, windowId: "0x15", title: "Second tab window" }]), undefined,
    "multiple eligible personal windows require the actual foreground identity");
});

test("multiple personal browser windows bind to the exact active HWND and never to a title, size, or stale desktop guess", () => {
  const first = { pid: 100, windowId: "0x11", appName: "chrome.exe", title: "Work", isOnScreen: true, minimized: false, onCurrentSpace: true, width: 1400, height: 900, zIndex: "2" };
  const active = { ...first, pid: 200, windowId: "0x22", title: "Personal", width: 800, height: 600, zIndex: "1" };
  const windows = [first, active];
  assert.equal(hasAmbiguousExistingPersonalBrowserWindow("chrome", windows), true);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", windows,
    { pid: 200, windowId: "0x22", onCurrentDesktop: true, visible: true, minimized: false }), active);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", windows,
    { pid: 999, windowId: "0x99", onCurrentDesktop: true, visible: true, minimized: false }), first,
    "an unrelated foreground app may fall back to the uniquely topmost eligible Chrome window");
  const noZOrder = windows.map(({ zIndex: _zIndex, ...window }) => window);
  assert.equal(selectExistingPersonalBrowserWindow("chrome", noZOrder,
    { pid: 200, windowId: "0x22", onCurrentDesktop: false, visible: true, minimized: false }), undefined);
  assert.equal(selectExistingPersonalBrowserWindow("chrome", noZOrder,
    { pid: 200, windowId: "0x22", onCurrentDesktop: true, visible: false, minimized: false }), undefined);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", windows), first,
    "when foreground identity does not identify a browser window, use a unique topmost window, never size or enumeration order");
  assert.equal(selectExistingPersonalBrowserWindow("chrome", [first, { ...active, zIndex: "2" }]), undefined,
    "tied or missing z-order is still ambiguous");
  assert.equal(selectExistingPersonalBrowserWindow("chrome", [{ ...first, zIndex: undefined }, { ...active, zIndex: undefined }]), undefined);
});

test("desktop app launch resolution prefers Windows-installed apps over package-manager shims", async () => {
  const env = { APPDATA: "C:\\Users\\owner\\AppData\\Roaming", PNPM_HOME: "C:\\Users\\owner\\.local\\share\\pnpm" };
  const npmShim = join(env.APPDATA, "npm", "codex.exe");
  const pnpmShim = join(env.PNPM_HOME, "codex.exe");
  assert.equal(isPackageManagerShimPath(npmShim, env), true);
  assert.equal(isPackageManagerShimPath(pnpmShim, env), true);
  assert.equal(isPackageManagerShimPath(join("C:\\Program Files", "Codex", "Codex.exe"), env), false);

  const installed = { executable: "C:\\Program Files\\WindowsApps\\Codex.exe", args: ["--registered-app"] };
  let discoveryCount = 0;
  assert.deepEqual(await resolveStageLaunchApp("codex", {
    env,
    resolveDirect: () => ({ executable: npmShim, args: [] }),
    discoverInstalledApp: async (name) => { assert.equal(name, "codex"); discoveryCount++; return installed; },
  }), installed);
  assert.equal(discoveryCount, 1);
  await assert.rejects(resolveStageLaunchApp("codex", {
    env,
    resolveDirect: () => ({ executable: npmShim, args: [] }),
    discoverInstalledApp: async () => undefined,
  }), /package-manager command shim.*was not launched/);

  const direct = { executable: "C:\\Program Files\\Notepad\\notepad.exe", args: [] };
  const packagedNotepad = { executable: "C:\\Windows\\explorer.exe", args: ["shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"], windowExecutable: "Notepad.exe" };
  assert.deepEqual(await resolveStageLaunchApp("notepad", {
    env, resolveDirect: () => direct, discoverInstalledApp: async () => packagedNotepad,
  }), packagedNotepad, "friendly names prefer the registered packaged app over a legacy compatibility executable");
  assert.deepEqual(await resolveStageLaunchApp("C:\\Program Files\\Notepad\\notepad.exe", {
    env, resolveDirect: () => direct, discoverInstalledApp: async () => assert.fail("an explicit executable path must bypass installed-app discovery"),
  }), direct);
  assert.deepEqual(await resolveStageLaunchApp("notepad", {
    env, resolveDirect: () => { throw new Error("No direct executable on PATH"); }, discoverInstalledApp: async () => installed,
  }), installed, "Windows app discovery also resolves names that have no direct executable");
});
