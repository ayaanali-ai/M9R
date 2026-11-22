import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { hasAmbiguousExistingPersonalBrowserWindow, isPackageManagerShimPath, ownedBrowserLaunch,
  resolveStageLaunchApp, selectExistingPersonalBrowserWindow, selectPersonalBrowserWindow, selectTargetAppWindow, stageWindowMatchesApp } from "../src/lib/native/task-stage-apps";

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

test("personal browser adoption chooses only a newly-created Chrome window", () => {
  const before = new Set(["100:0x10"]);
  const candidate = { pid: 100, windowId: "0x11", appName: "chrome.exe", title: "New Tab" };
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [candidate], before), candidate);
  assert.equal(selectPersonalBrowserWindow("chrome", [{ ...candidate, windowId: "0x10" }], before), undefined);
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [candidate, { ...candidate, windowId: "0x12" }], before), candidate,
    "native EnumWindows order provides a deterministic fallback among exact fresh browser windows");
  const second = { ...candidate, windowId: "0x12", zOrder: 1 };
  const top = { ...candidate, zOrder: 0 };
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [second, top], before), top,
    "the OS topmost exact browser window wins when several are created together");
  assert.equal(selectPersonalBrowserWindow("chrome", [{ ...candidate, appName: "msedge.exe" }], new Set()), undefined);
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [{ ...candidate, appName: "Chrome_WidgetWin_1" }], new Set()), { ...candidate, appName: "Chrome_WidgetWin_1" });
});

test("personal browser adoption ignores hidden and minimized helper windows and does not consult desktop metadata", () => {
  const visible = { pid: 100, windowId: "0x11", appName: "chrome.exe", title: "New Tab", isOnScreen: true, minimized: false, width: 1200, height: 800 };
  const helper = { ...visible, windowId: "0x12", isOnScreen: false, title: "Chrome helper" };
  const minimized = { ...visible, windowId: "0x13", minimized: true };
  const legacyOffDesktopFlag = { ...visible, windowId: "0x14", onCurrentSpace: false };
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [helper, minimized, visible], new Set()), visible);
  assert.deepEqual(selectPersonalBrowserWindow("chrome", [legacyOffDesktopFlag], new Set()), legacyOffDesktopFlag,
    "legacy desktop-affinity metadata cannot hide a valid exact browser HWND");
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", [helper, minimized, visible]), visible);
  assert.equal(selectExistingPersonalBrowserWindow("chrome", [visible, { ...visible, windowId: "0x15", title: "Second tab window" }]), undefined,
    "multiple eligible personal windows require the actual foreground identity");
});

test("multiple personal browser windows bind to the exact active HWND and never to a title, size, or stale desktop guess", () => {
  const first = { pid: 100, windowId: "0x11", appName: "chrome.exe", title: "Work", isOnScreen: true, minimized: false, onCurrentSpace: true, width: 1400, height: 900, zIndex: "2" };
  const active = { ...first, pid: 200, windowId: "0x22", title: "Personal", width: 800, height: 600, zIndex: "1" };
  const windows = [first, active];
  assert.equal(hasAmbiguousExistingPersonalBrowserWindow("chrome", windows), true);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", windows,
    { pid: 200, windowId: "0x22", visible: true, minimized: false }), active);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", windows,
    { pid: 999, windowId: "0x99", visible: true, minimized: false }), first,
    "an unrelated foreground app may fall back to the uniquely topmost eligible Chrome window");
  const noZOrder = windows.map(({ zIndex: _zIndex, ...window }) => window);
  assert.equal(selectExistingPersonalBrowserWindow("chrome", noZOrder,
    { pid: 200, windowId: "0x22", visible: true, minimized: true }), undefined);
  assert.equal(selectExistingPersonalBrowserWindow("chrome", noZOrder,
    { pid: 200, windowId: "0x22", visible: false, minimized: false }), undefined);
  assert.deepEqual(selectExistingPersonalBrowserWindow("chrome", windows), first,
    "when foreground identity does not identify a browser window, use a unique topmost window, never size or enumeration order");
  assert.equal(selectExistingPersonalBrowserWindow("chrome", [first, { ...active, zIndex: "2" }]), undefined,
    "tied or missing z-order is still ambiguous");
  assert.equal(selectExistingPersonalBrowserWindow("chrome", [{ ...first, zIndex: undefined }, { ...active, zIndex: undefined }]), undefined);
});

test("exact app windows use foreground identity, then the native top-to-bottom order", () => {
  const top = { pid: 10, windowId: "0x10", appName: "CalculatorApp.exe", title: "Calculator", zOrder: 0 };
  const foreground = { pid: 11, windowId: "0x11", appName: "CalculatorApp.exe", title: "Calculator", zOrder: 1 };
  assert.deepEqual(selectTargetAppWindow([foreground, top]), top,
    "EnumWindows order is the deterministic fallback when foreground metadata is unavailable");
  assert.deepEqual(selectTargetAppWindow([top, foreground], { pid: 11, windowId: "0x11", visible: true, minimized: false }), foreground,
    "an exact foreground target wins when the app has multiple windows");
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
  const packagedNotepad = { executable: "C:\\Windows\\explorer.exe", args: ["shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"], windowExecutable: "Notepad.exe", windowExecutablePath: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe", appUserModelId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" };
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

test("packaged Windows apps bind only the ApplicationFrameHost window with the exact app identity", () => {
  const appUserModelId = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
  const packaged = { executable: "C:\\Windows\\explorer.exe", args: [`shell:AppsFolder\\${appUserModelId}`], windowExecutable: "CalculatorApp.exe", appUserModelId };
  assert.equal(stageWindowMatchesApp({ pid: 42, windowId: "0x1", appName: "ApplicationFrameHost.exe", appUserModelId, title: "Calculator", width: 800, height: 600 }, packaged), true);
  assert.equal(stageWindowMatchesApp({ pid: 43, windowId: "0x2", appName: "ApplicationFrameHost.exe", appUserModelId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", title: "Notepad", width: 800, height: 600 }, packaged), false);
  assert.equal(stageWindowMatchesApp({ pid: 44, windowId: "0x3", appName: "ApplicationFrameWindow", title: "Settings", width: 800, height: 600 }, packaged), false,
    "a generic nonempty frame title is not proof of the requested app identity");
  assert.equal(stageWindowMatchesApp({ pid: 42, windowId: "0x1", appName: "explorer.exe", title: "Program Manager", width: 800, height: 600 }, packaged), false);

  const packagedNotepad = {
    executable: "C:\\Windows\\explorer.exe",
    args: ["shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"],
    windowExecutable: "Notepad.exe",
    windowExecutablePath: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
    appUserModelId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
  };
  assert.equal(stageWindowMatchesApp({ pid: 45, windowId: "0x4", appName: "Notepad.exe", processPath: packagedNotepad.windowExecutablePath, title: "Notepad", width: 800, height: 600 }, packagedNotepad), true,
    "self-hosted packaged apps match their exact manifest path when the HWND has no AppUserModelId");
  assert.equal(stageWindowMatchesApp({ pid: 46, windowId: "0x5", appName: "Notepad.exe", processPath: "C:\\Windows\\System32\\notepad.exe", title: "Notepad", width: 800, height: 600 }, packagedNotepad), false,
    "the legacy same-named executable cannot impersonate the packaged app");
});
