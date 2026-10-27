import assert from "node:assert/strict";
import test from "node:test";
import { discoverInstalledWindowsApp, WINDOWS_APP_DISCOVERY_SCRIPT } from "../src/lib/native/windows-installed-apps";

const LEGACY_NOTEPAD = { executable: "C:\\Windows\\System32\\notepad.exe", args: [] as string[] };
const PACKAGED_NOTEPAD = {
  executable: "C:\\Windows\\explorer.exe",
  args: ["shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"],
  windowExecutable: "Notepad.exe",
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
});

test("throws when the same query genuinely matches two unrelated, non-dedupable apps", async () => {
  const unrelatedOne = { executable: "C:\\Program Files\\AppOne\\one.exe", args: [] as string[] };
  const unrelatedTwo = { executable: "C:\\Program Files\\AppTwo\\two.exe", args: [] as string[] };
  await assert.rejects(
    () => discoverInstalledWindowsApp("notepad", async () => JSON.stringify([unrelatedOne, unrelatedTwo])),
    /multiple installed apps/);
});
