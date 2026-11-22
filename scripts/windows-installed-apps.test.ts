import assert from "node:assert/strict";
import test from "node:test";
import { stageWindowMatchesApp } from "../src/lib/native/task-stage-apps";
import { discoverInstalledWindowExecutable, discoverInstalledWindowsApp, WINDOWS_APP_DISCOVERY_SCRIPT, WINDOWS_RENDERER_DISCOVERY_SCRIPT, windowsAppSearchNames } from "../src/lib/native/windows-installed-apps";

const LEGACY_NOTEPAD = { executable: "C:\\Windows\\System32\\notepad.exe", args: [] as string[] };
const PACKAGED_NOTEPAD = {
  executable: "C:\\Windows\\explorer.exe",
  args: ["shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"],
  windowExecutable: "Notepad.exe",
  windowExecutablePath: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
  appUserModelId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
};

test("prefers the packaged app over a legacy App Paths compatibility stub when both are found", async () => {
  const app = await discoverInstalledWindowsApp("notepad", async () => JSON.stringify([LEGACY_NOTEPAD, PACKAGED_NOTEPAD]));
  assert.deepEqual(app, PACKAGED_NOTEPAD,
    "when a legacy App Paths stub and the modern packaged app are both discovered, the packaged app must win");
});

test("still resolves the legacy exe when no packaged app exists for it", async () => {
  const app = await discoverInstalledWindowsApp("notepad", async () => JSON.stringify([LEGACY_NOTEPAD]));
  assert.deepEqual(app, LEGACY_NOTEPAD);
});

test("still resolves a packaged app when no legacy App Paths stub exists for it", async () => {
  const app = await discoverInstalledWindowsApp("notepad", async () => JSON.stringify([PACKAGED_NOTEPAD]));
  assert.deepEqual(app, PACKAGED_NOTEPAD);
});

test("queries both modern Notepad registration names before falling back to the legacy executable", () => {
  assert.deepEqual(windowsAppSearchNames("notepad").map((name) => name.toLowerCase()), ["notepad", "windows notepad"]);
});

test("a multi-word alias still resolves when spaced, punctuated, or cased differently than its exact table entry", () => {
  // APP_ALIASES is keyed by raw strings like "google chrome", but every name
  // this function actually compares against is first stripped to letters and
  // digits only (appNameKey). A lookup by that stripped key against the raw,
  // space-containing table key always missed; only the exact literal spelling
  // ("Google Chrome", via the lowercase-exact fallback) ever found its alias.
  // Any other spacing/punctuation/casing resolved zero aliases and fell
  // straight through to whatever happened to match the literal name --
  // exactly the legacy-stub problem this alias table exists to prevent.
  for (const variant of ["Google Chrome", "GoogleChrome", "google  chrome", "google-chrome", "GOOGLE CHROME"]) {
    assert.deepEqual(windowsAppSearchNames(variant).map((name) => name.toLowerCase()), ["google chrome", "chrome"],
      `"${variant}" must resolve the same chrome alias as the exact table entry`);
  }
  for (const variant of ["File Explorer", "FileExplorer", "file  explorer"]) {
    assert.deepEqual(windowsAppSearchNames(variant).map((name) => name.toLowerCase()), ["file explorer", "explorer", "windows explorer"],
      `"${variant}" must resolve the same explorer aliases as the exact table entry`);
  }
});

test("the discovery script collects App Paths matches without exiting before the packaged-app lookup runs", () => {
  // Regression guard for the real bug: an early `exit 0` right after the App
  // Paths loop meant a legacy compatibility stub always won without the
  // packaged-app (Get-StartApps) lookup ever running. Assert the script no
  // longer short-circuits before that lookup.
  const appPathsLoopEnd = WINDOWS_APP_DISCOVERY_SCRIPT.indexOf("Get-StartApps");
  const textBeforePackagedLookup = WINDOWS_APP_DISCOVERY_SCRIPT.slice(0, appPathsLoopEnd);
  assert.ok(appPathsLoopEnd > 0, "the script must still query Get-StartApps for the packaged app");
  assert.equal(/\bexit\s+0\b/.test(textBeforePackagedLookup), false,
    "the script must not exit before the packaged-app (Get-StartApps) lookup runs");
  assert.match(WINDOWS_APP_DISCOVERY_SCRIPT, /appUserModelId\s*=\s*\[string\]\s+\$app\.AppID/,
    "packaged launch results must carry the exact Windows app identity into window matching");
  assert.match(WINDOWS_APP_DISCOVERY_SCRIPT, /windowExecutablePath\s*=\s*\[IO\.Path\]::GetFullPath/,
    "packaged launch results must carry an exact executable path for self-hosted packaged windows");
});

test("renderer identity lookup returns the exact packaged image path, not only a basename", async () => {
  const expected = "C:\\Program Files\\WindowsApps\\Example_1.0.0.0_x64__publisher\\App.exe";
  const actual = await discoverInstalledWindowExecutable("C:\\Windows\\System32\\example.exe", async (script) => {
    assert.equal(script, WINDOWS_RENDERER_DISCOVERY_SCRIPT);
    return JSON.stringify([expected]);
  });
  assert.equal(actual, expected);
});

test("throws when the same query genuinely matches two unrelated, non-dedupable apps", async () => {
  const unrelatedOne = { executable: "C:\\Program Files\\AppOne\\one.exe", args: [] as string[] };
  const unrelatedTwo = { executable: "C:\\Program Files\\AppTwo\\two.exe", args: [] as string[] };
  await assert.rejects(
    () => discoverInstalledWindowsApp("notepad", async () => JSON.stringify([unrelatedOne, unrelatedTwo])),
    /multiple installed apps/);
});

test("packaged renderer lookup carries the requested app identity instead of Explorer identity", async () => {
  const expected = "C:\\Program Files\\WindowsApps\\Drawing.Package\\Drawing.exe";
  const renderer = await discoverInstalledWindowExecutable("C:\\Windows\\explorer.exe", async (script, env) => {
    assert.equal(env.M9R_APP_AUMID, "Drawing.Package!App");
    assert.match(script, /\$env:M9R_APP_AUMID/);
    return JSON.stringify([expected]);
  }, "Drawing.Package!App");
  assert.equal(renderer, expected);
});

test("packaged windows without AUMID require the resolved renderer's exact path", () => {
  const renderer = "C:\\Program Files\\WindowsApps\\Drawing.Package\\Drawing.exe";
  const app = { executable: "C:\\Windows\\explorer.exe", args: ["shell:AppsFolder\\Drawing.Package!App"], appUserModelId: "Drawing.Package!App" };
  const window = { pid: 123, windowId: "456", appName: "Drawing.exe", title: "Untitled", className: "DrawingFrame", visible: true, minimized: false, processPath: renderer };
  assert.equal(stageWindowMatchesApp(window, app), false);
  const resolved = { ...app, windowExecutable: renderer, windowExecutablePath: renderer };
  assert.equal(stageWindowMatchesApp(window, resolved), true);
  assert.equal(stageWindowMatchesApp({ ...window, processPath: "C:\\Other\\Drawing.exe" }, resolved), false);
});
