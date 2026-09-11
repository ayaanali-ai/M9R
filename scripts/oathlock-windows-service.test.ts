import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsLaunchScript,
  buildHiddenLaunchCommand,
  buildRegAddArgs,
  buildRegDeleteArgs,
  buildRegQueryArgs,
  WINDOWS_RUN_KEY_PATH,
  WINDOWS_RUN_KEY_VALUE_NAME,
} from "@/lib/oathlock-windows-service";

test("buildWindowsLaunchScript waits for explorer.exe before launching, not immediately -- confirmed live this is why the login launcher silently never boots real work: a process started this early can carry a logon-session token Windows tears down once the real desktop session stabilizes", () => {
  const script = buildWindowsLaunchScript({
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    nodeArgs: ["--import", "file:///C:/repo/scripts/register-alias.mjs"],
    cliEntryPath: "C:\\repo\\scripts\\oathlock-cli.ts",
    args: ["terminal", "runtime"],
    workingDirectory: "C:\\repo",
  });
  assert.match(script, /Get-Process -Name explorer/, "must wait for the interactive shell before launching");
  const waitIndex = script.indexOf("Get-Process -Name explorer");
  const startIndex = script.indexOf("Start-Process -FilePath");
  assert.ok(waitIndex >= 0 && startIndex > waitIndex, "the explorer wait must come before Start-Process, not after");
});

test("buildWindowsLaunchScript's Start-Process carries node flags, the entry path, and CLI args in that order -- a raw .ts entry needs --import register-alias.mjs (as a file:// URL, not a bare Windows path -- Node's ESM loader rejects that) or every @/lib-aliased import throws immediately with no console to show it in", () => {
  const script = buildWindowsLaunchScript({
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    nodeArgs: ["--disable-warning=ExperimentalWarning", "--import", "file:///C:/repo/scripts/register-alias.mjs"],
    cliEntryPath: "C:\\repo\\scripts\\oathlock-cli.ts",
    args: ["terminal", "runtime"],
    workingDirectory: "C:\\repo",
  });
  const startLine = script.split("\r\n").find((line) => line.startsWith("Start-Process"));
  assert.ok(startLine, "Start-Process line must exist");
  const argListMatch = startLine!.match(/-ArgumentList @\(([^)]*)\)/);
  assert.ok(argListMatch, "must have an -ArgumentList array");
  const args = argListMatch![1];
  const disableWarningPos = args.indexOf("'--disable-warning=ExperimentalWarning'");
  const importFlagPos = args.indexOf("'--import'");
  const importUrlPos = args.indexOf("'file:///C:/repo/scripts/register-alias.mjs'");
  const entryPos = args.indexOf("'C:\\repo\\scripts\\oathlock-cli.ts'");
  const terminalPos = args.indexOf("'terminal'");
  const runtimePos = args.indexOf("'runtime'");
  assert.ok(
    disableWarningPos < importFlagPos && importFlagPos < importUrlPos && importUrlPos < entryPos && entryPos < terminalPos && terminalPos < runtimePos,
    `node flags, entry path, and CLI args must appear in that exact order: ${args}`,
  );
  // The exact bug fixed earlier: a bare Windows path handed to --import
  // fails ESM's URL scheme check. Any regression back to a raw "C:\..."
  // value here (instead of a file:// URL) must fail this test.
  assert.ok(!args.includes("'C:/repo/scripts/register-alias.mjs'"), "the --import target must be a file:// URL, not a bare path");
});

test("buildWindowsLaunchScript quotes a working directory containing a single quote without breaking the PowerShell literal", () => {
  const script = buildWindowsLaunchScript({
    nodeExecutable: "node.exe",
    nodeArgs: [],
    cliEntryPath: "entry.js",
    args: [],
    workingDirectory: "C:\\Users\\O'Brien\\repo",
  });
  assert.match(script, /'C:\\Users\\O''Brien\\repo'/, "a single quote inside a PowerShell single-quoted literal must be doubled, not escaped with a backslash");
});

test("buildHiddenLaunchCommand wraps the script path in a hidden, non-interactive powershell invocation", () => {
  const command = buildHiddenLaunchCommand("C:\\repo\\.oathlock\\service-launch.ps1");
  assert.match(command, /^powershell\.exe /);
  assert.match(command, /-WindowStyle Hidden/);
  assert.match(command, /-ExecutionPolicy Bypass/);
  assert.match(command, /"C:\\repo\\\.oathlock\\service-launch\.ps1"/);
});

test("buildRegAddArgs / buildRegDeleteArgs / buildRegQueryArgs all target the same HKCU Run key and value name", () => {
  const scriptPath = "C:\\repo\\.oathlock\\service-launch.ps1";
  const addArgs = buildRegAddArgs(scriptPath);
  const deleteArgs = buildRegDeleteArgs();
  const queryArgs = buildRegQueryArgs();
  for (const args of [addArgs, deleteArgs, queryArgs]) {
    assert.ok(args.includes(WINDOWS_RUN_KEY_PATH), `must reference ${WINDOWS_RUN_KEY_PATH}`);
    assert.ok(args.includes(WINDOWS_RUN_KEY_VALUE_NAME), `must reference ${WINDOWS_RUN_KEY_VALUE_NAME}`);
  }
  assert.equal(addArgs[0], "add");
  assert.equal(deleteArgs[0], "delete");
  assert.equal(queryArgs[0], "query");
  assert.ok(addArgs.includes("/f"), "add must force-overwrite an existing value, or reinstalling never self-heals a stale one");
});
