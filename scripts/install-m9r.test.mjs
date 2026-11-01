import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const installer = resolve("scripts/install-m9r.ps1");
const engineDist = resolve("engine/dist");
const releasePackager = resolve("scripts/package-engine-release.ps1");
const engineBuilder = resolve("scripts/build-engine.mjs");
const powershell = process.env.M9R_TEST_PWSH ?? "pwsh";
const canRunNativeInstaller = process.platform === "win32"
  && ["m9r-engine.exe", "m9r-native-input-host.exe", "m9r-web-broker.exe"].every((name) => existsSync(join(engineDist, name)))
  && existsSync(join(engineDist, "m9r-overlay.exe"))
  && existsSync(join(engineDist, "m9r-build-info.json"));
const skipNative = canRunNativeInstaller ? false : "Windows engine binaries are required (CI builds them first).";

test("a historically verified candidate cannot authorize itself over the current policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "m9r-policy-authority-"));
  try {
    const source = readFileSync(installer, "utf8");
    const start = source.indexOf("function Assert-AcceptedRuntimePackage(");
    const end = source.indexOf("function Get-ManagedWebBrokerPaths", start);
    assert.ok(start >= 0 && end > start);
    writeFileSync(join(directory, "m9r-build-info.json"), JSON.stringify({ schemaVersion: 1, buildId: "b".repeat(64), artifacts: {} }));
    const script = join(directory, "check.ps1");
    writeFileSync(script, `$ErrorActionPreference = 'Stop'\n$AllowLocalCandidate = $true\nfunction Assert-LocalCandidateReceipt { }\nfunction Get-AcceptedRuntimeIdentity { return @{ schemaVersion=1; buildId=('a' * 64); artifacts=@{} } }\n${source.slice(start, end)}\ntry { Assert-AcceptedRuntimePackage $PSScriptRoot; throw 'SELF_AUTHORIZED' } catch { if ($_.Exception.Message -notlike '*owner-accepted live pill*') { throw }; Write-Output 'REJECTED_BY_CURRENT_POLICY' }\n`);
    const result = runPowerShell(script);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /REJECTED_BY_CURRENT_POLICY/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function runPowerShell(script, args = [], { input, env = process.env } = {}) {
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", script, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    env,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function createPackage(directory) {
  const packaged = runPowerShell(releasePackager, [directory]);
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
  const zipPath = join(directory, "m9r-engine-windows-x64.zip");
  assert.ok(existsSync(zipPath), "the accepted release packager must create the complete test package");
  return zipPath;
}

function makeProfile(parent) {
  const profile = join(parent, "profile");
  const m9rHome = join(parent, "m9r-data");
  const claude = join(parent, "claude-config");
  const codex = join(parent, "codex-home");
  mkdirSync(profile, { recursive: true });
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return {
    profile,
    m9rHome,
    claude,
    codex,
    env: {
      ...process.env,
      USERPROFILE: profile,
      HOME: profile,
      HOMEDRIVE: profile.slice(0, 2),
      HOMEPATH: profile.slice(2),
      M9R_HOME: m9rHome,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      M9R_NO_DAEMON: "1",
    },
  };
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function canonicalPath(path) {
  return realpathSync.native(path).replace(/^\\\\\?\\/, "").toLowerCase();
}

test("installer contains no Node/npm dependency and changes no saved PowerShell policy", () => {
  const source = readFileSync(installer, "utf8");
  assert.doesNotMatch(source, /(?:&\s*|Get-Command\s+)(?:npm|node)(?:\.exe)?\b/i);
  assert.doesNotMatch(source, /ExecutionPolicy\s+Bypass|Invoke-Expression|\biex\b/i);
  assert.match(source, /Get-FileHash[\s\S]*SHA256/);
  assert.match(source, /\$dryRunArgs\s*=\s*@\('setup',\s*'--dry-run',\s*'--yes'\)/);
  assert.match(source, /\$applyArgs\s*=\s*@\('setup',\s*'--yes'\)/);
  assert.match(source, /function Get-M9rHome/);
  assert.match(source, /Get-M9rHome/);
  assert.match(source, /\$AllowLocalCandidate[\s\S]*\$CandidateReceiptPath/);
  assert.match(source, /Never trust the policy copied beside an installer inside the ZIP/);
  assert.match(source, /external candidate receipt does not match the exact ZIP, source, runtime, or pill/);
  assert.doesNotMatch(source, /Join-Path \$PSScriptRoot 'm9r-accepted-runtime\.json'/,
    "a package must not use its own embedded runtime policy as its trust root");
  assert.match(source, /\[switch\]\$NoAutostart/);
  assert.match(source, /\[switch\]\$NoLaunch/);
  assert.match(source, /function Stop-InstalledM9rPill/);
  assert.match(source, /--m9r-update-shutdown/, "pill updates must use the app's single-instance shutdown handoff");
  assert.match(source, /WaitForExit\(15000\)/, "the installer must wait for the installed pill to exit before replacing its image");
  assert.match(source, /function Invoke-ManagedBrokerUpdate/);
  const suspendIndex = source.indexOf('$brokerTaskState = Suspend-ManagedBrokerAutoStart');
  const stopIndex = source.indexOf("$brokerStop = Invoke-ManagedBrokerUpdate $engine 'stop'");
  assert.ok(suspendIndex >= 0 && stopIndex > suspendIndex,
    "the managed broker autostart task must be suspended before the authenticated stop to prevent a respawn/relock race");
  assert.match(source, /Invoke-ManagedBrokerUpdate\s+\$engine\s+'stop'[\s\S]*Stop-InstalledM9rPill[\s\S]*& \$engine \@applyArgs/,
    "updates must authenticate and stop the owned broker before engine setup can replace its runtime image");
  assert.match(source, /Invoke-ManagedBrokerUpdate\s+\$installedEngine\s+'start'/,
    "updates must restart and verify the owned broker using the newly installed engine");
  assert.match(source, /brokerNeedsResume[\s\S]*Invoke-ManagedBrokerUpdate \$brokerResumeEngine 'start'/,
    "a failed install must attempt to restore the previously managed broker");
  assert.match(source, /Start-Process -FilePath \$installedOverlay/);
  assert.match(source, /--autostart/);
  assert.match(source, /maintenanceExe uninstall/);
  const clickEntry = readFileSync(resolve("scripts/install-m9r.cmd"), "utf8");
  assert.match(clickEntry, /powershell\.exe/i);
  assert.match(clickEntry, /powershell\.exe[^\r\n]*-ExecutionPolicy\s+Bypass[^\r\n]*-File/i);
  assert.doesNotMatch(clickEntry, /Set-ExecutionPolicy/i);
});

test("standalone release packages runtime companions from the canonical engine distribution", () => {
  const packagerSource = readFileSync(releasePackager, "utf8");
  const installerSource = readFileSync(installer, "utf8");
  const builderSource = readFileSync(engineBuilder, "utf8");
  const workflowSource = readFileSync(resolve(".github/workflows/m9r-engine-release.yml"), "utf8");
  const cliSource = readFileSync(resolve("scripts/m9r-cli.ts"), "utf8");
  assert.match(builderSource, /release-assets", "accepted-ui", "m9r-overlay\.exe"/,
    "the runtime builder must use the exact owner-accepted live pill artifact");
  assert.match(builderSource, /acceptedOverlayHash/,
    "the packaged pill must match the accepted runtime hash before staging");
  assert.match(builderSource, /M9R_OVERLAY_EXE is not a supported build input/,
    "callers must not substitute an arbitrary pill executable");
  assert.match(builderSource, /m9r-web-broker\.cjs[\s\S]*m9r-web-broker\.exe/, "the build must turn the bundled broker into its own executable");
  assert.match(builderSource, /copyFileSync\(overlayExe, join\(out, "m9r-overlay\.exe"\)\)/, "the engine distribution must capture the owner-accepted live pill");
  const manifestWriteIndex = builderSource.indexOf("writeRuntimeBuildManifest(out");
  const stagedVerifyIndex = builderSource.indexOf("verifyRuntimeBuildManifest(out, { exact: true })");
  const publishIndex = builderSource.indexOf("publishRuntimeBuild(out, output)");
  assert.ok(manifestWriteIndex >= 0 && stagedVerifyIndex > manifestWriteIndex && publishIndex > stagedVerifyIndex,
    "the complete artifact set must be hashed and verified before it is published");
  assert.match(builderSource, /rmSync\(buildRoot, \{ recursive: true, force: true \}\)/, "only the unique build staging directory may be removed after publication");
  assert.doesNotMatch(builderSource, /rmSync\(out,\s*\{\s*recursive:\s*true/, "the build must not delete its only staged runtime before verification");
  assert.match(builderSource, /publishRuntimeBuild\(out, output\)/, "the exact staged runtime replaces the dedicated engine/dist snapshot");
  assert.match(packagerSource, /m9r-web-broker\.exe/, "the release ZIP must contain the standalone broker");
  assert.match(packagerSource, /m9r-overlay\.exe/, "the release ZIP must contain the M9R desktop pill");
  assert.match(packagerSource, /m9r-build-info\.json/, "the release ZIP must contain the runtime artifact identity manifest");
  assert.match(packagerSource, /\$overlay\s*=\s*Join-Path\s+\$dist\s+'m9r-overlay\.exe'/, "the release ZIP must take the pill from the same engine distribution used by local setup");
  assert.doesNotMatch(packagerSource, /overlay\\src-tauri\\target\\release\\m9r-overlay\.exe/i, "release packaging must not bypass the canonical engine distribution");
  const engineBuildIndex = workflowSource.indexOf("npm run build:engine");
  assert.ok(engineBuildIndex >= 0 && !workflowSource.includes("npm --prefix overlay run build"),
    "the release workflow must package the accepted live pill rather than compile an unreviewed target binary");
  assert.match(packagerSource, /m9r-accepted-runtime\.json/,
    "the release must publish an independent runtime policy asset for installer verification");
  assert.match(installerSource, /m9r-web-broker\.exe/, "the installer must require the broker from the verified package");
  assert.match(installerSource, /m9r-overlay\.exe/, "the installer must require the M9R desktop pill from the verified package");
  assert.match(installerSource, /m9r-build-info\.json/, "the installer must require the runtime artifact identity manifest");
  assert.match(installerSource, /Install-ManagedWebBroker/, "the installer must place the broker beside the installed engine");
  assert.match(installerSource, /claim an identical companion/, "the installer must claim the broker after the engine copies its companion files");
  assert.match(installerSource, /Remove-ManagedWebBroker/, "uninstall must remove only the unchanged installer-owned broker");
  assert.match(installerSource, /web-broker-install\.json/, "the broker ownership record must persist across installer runs");
  assert.doesNotMatch(installerSource, /& \$installedEngine web setup/, "the retired web/provider-hook setup must not be reachable from the installer");
  assert.match(installerSource, /Invoke-ManagedBrokerUpdate \$installedEngine 'start'/,
    "the broker-owned desktop runtime must be started beside the persistent engine");
  assert.match(cliSource, /args\[0\] === "broker-update"/, "the packaged engine must expose the installer's broker lifecycle command");
});

test("runtime updates fail closed on a locked image and never create retired executable siblings", () => {
  const nativeSource = readFileSync(resolve("src/lib/native/native-commands.ts"), "utf8");
  assert.match(nativeSource, /function replaceRuntimeFile\([\s\S]*?renameSync\(staged, to\)/);
  assert.match(nativeSource, /locked runtime file at its stable path/);
  assert.doesNotMatch(nativeSource, /\.m9r-retired-/);
  assert.match(nativeSource, /installRuntimeTransaction\(plan\.targetDir, files, replaceRuntimeFile, removeTargets\)/);
  assert.match(nativeSource, /obsoleteOwnedRuntimeEntries/);
  const transactionSource = readFileSync(resolve("src/lib/native/runtime-install-transaction.ts"), "utf8");
  assert.match(transactionSource, /removeTargets: readonly string\[\] = \[\]/);
  assert.match(transactionSource, /DEFAULT_COMPLETED_TRANSACTION_RETENTION = 0/);
  assert.doesNotMatch(transactionSource, /M9R_PRESERVE_RUNTIME_EVIDENCE/);
});

test("standalone installer includes the separately managed broker in its complete runtime transaction", () => {
  const installerSource = readFileSync(resolve("scripts/install-m9r.ps1"), "utf8");
  assert.equal((installerSource.match(/\$env:M9R_INCLUDE_MANAGED_BROKER = '1'/g) ?? []).length, 2,
    "the broker must be part of both the reviewed dry-run plan and the applied package transaction");
  assert.match(installerSource, /Install-ManagedWebBroker \$packageBroker/,
    "the standalone broker ownership record is refreshed only after the runtime transaction");
});

test("release ZIP contains the built standalone broker", { skip: skipNative }, (t) => {
  const temp = mkdtempSync(join(tmpdir(), "m9r-release-package-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const packaged = runPowerShell(releasePackager, [temp]);
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
  const zipPath = join(temp, "m9r-engine-windows-x64.zip");
  const inspect = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [IO.Compression.ZipFile]::OpenRead('${zipPath.replaceAll("'", "''")}')`,
    "try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }",
  ].join("\n");
  const listed = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(inspect, "utf16le").toString("base64")], { encoding: "utf8", timeout: 180_000 });
  if (listed.error) throw listed.error;
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /^m9r-web-broker\.exe\s*$/m);
  assert.match(listed.stdout, /^m9r-overlay\.exe\s*$/m);
  assert.match(listed.stdout, /^m9r-build-info\.json\s*$/m);
  assert.doesNotMatch(listed.stdout, /(?:^|\\)m9r-hook\.exe\s*$/m, "the retired provider hook must not ship");
  assert.doesNotMatch(listed.stdout, /^extension\\/m, "the retired browser-extension transport must not ship");
});

test("standalone package consent, setup, integrity, and uninstall paths", { skip: skipNative }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "m9r-real-installer-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const zipPath = createPackage(temp);

  await t.test("default consent preview includes sign-in startup and decline writes nothing", () => {
    const profile = makeProfile(join(temp, "startup-preview-case"));
    const result = runPowerShell(installer, ["-PackagePath", zipPath], { input: "n\n", env: profile.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /M9R will start the desktop pill when this Windows user signs in/i);
    assert.match(result.stdout, /start the M9R desktop pill when this Windows user signs in/i);
    assert.equal(existsSync(profile.m9rHome), false, "declining must not create the configured M9R_HOME");
    assert.equal(listFiles(profile.claude).length, 0);
    assert.equal(listFiles(profile.codex).length, 0);
  });

  await t.test("NoAutostart consent preview omits sign-in startup", () => {
    const profile = makeProfile(join(temp, "no-startup-preview-case"));
    const result = runPowerShell(installer, ["-PackagePath", zipPath, "-NoAutostart"], { input: "n\n", env: profile.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /start the desktop pill when this Windows user signs in/i);
    assert.doesNotMatch(result.stdout, /start the M9R desktop pill when this Windows user signs in/i);
    assert.equal(existsSync(profile.m9rHome), false, "declining must not create the configured M9R_HOME");
  });

  await t.test("one explicit approval installs the actual engine; uninstall works from a maintenance copy", async () => {
    const profile = makeProfile(join(temp, "install-case"));
    const originalFiles = new Map([
      [join(profile.claude, "settings.json"), '{"userSetting":true}\n'],
      [join(profile.claude, "CLAUDE.md"), "# User-authored Claude instructions\n"],
      [join(profile.codex, "config.toml"), "# User-authored Codex config\n"],
      [join(profile.codex, "AGENTS.md"), "# User-authored Codex instructions\n"],
    ]);
    for (const [path, contents] of originalFiles) writeFileSync(path, contents);
    const installed = runPowerShell(installer, ["-PackagePath", zipPath, "-NoAutostart", "-NoLaunch"], { input: "y\n", env: profile.env });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.match(installed.stdout, /M9R FIRST-RUN CONSENT/);
    assert.match(installed.stdout, /Exact setup plan from the engine/);
    assert.match(installed.stdout, /m9r-engine uninstall/);
    assert.ok(existsSync(join(profile.m9rHome, "bin", "m9r-engine.exe")));
    assert.equal(existsSync(join(profile.m9rHome, "bin", "m9r-hook.exe")), false, "the retired provider hook binary must never be installed");
    assert.ok(existsSync(join(profile.m9rHome, "bin", "m9r-native-input-host.exe")));
    assert.ok(existsSync(join(profile.m9rHome, "bin", "m9r-build-info.json")));
    const installedOverlay = join(profile.m9rHome, "bin", "m9r-overlay.exe");
    assert.ok(existsSync(installedOverlay));
    assert.deepEqual(readFileSync(installedOverlay), readFileSync(join(engineDist, "m9r-overlay.exe")));
    const installedBroker = join(profile.m9rHome, "bin", "m9r-web-broker.exe");
    assert.ok(existsSync(installedBroker));
    assert.deepEqual(readFileSync(installedBroker), readFileSync(join(engineDist, "m9r-web-broker.exe")));
    const brokerOwnershipPath = join(profile.m9rHome, "web-broker-install.json");
    const brokerOwnershipBytes = readFileSync(brokerOwnershipPath);
    assert.equal(brokerOwnershipBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, "the broker ownership JSON must be UTF-8 without a BOM so Node can parse it");
    const brokerOwnership = JSON.parse(brokerOwnershipBytes.toString("utf8"));
    // Windows may spell the same file differently when it uses an 8.3 account alias.
    // Resolve both paths through the OS before comparing their identities.
    assert.equal(canonicalPath(brokerOwnership.path), canonicalPath(installedBroker));
    assert.equal(brokerOwnership.sha256, createHash("sha256").update(readFileSync(installedBroker)).digest("hex"));
    assert.ok(listFiles(profile.claude).some((file) => /settings\.json$/i.test(file)));
    assert.ok(listFiles(profile.codex).some((file) => /config\.toml$/i.test(file)));

    const uninstalled = runPowerShell(installer, ["-Uninstall"], { input: "y\n", env: profile.env });
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.match(uninstalled.stdout, /M9R setup was removed/);
    assert.match(uninstalled.stdout, /M9R uninstall will:/);
    assert.equal(existsSync(join(profile.m9rHome, "bin", "m9r-engine.exe")), false);
    assert.equal(existsSync(join(profile.m9rHome, "bin", "m9r-hook.exe")), false);
    assert.equal(existsSync(join(profile.m9rHome, "bin", "m9r-native-input-host.exe")), false);
    assert.equal(existsSync(installedOverlay), false);
    assert.equal(existsSync(installedBroker), false);
    assert.equal(existsSync(brokerOwnershipPath), false);
    for (const [path, contents] of originalFiles) assert.equal(readFileSync(path, "utf8"), contents, `${path} must be restored exactly`);
  });

  await t.test("a broker replaced by engine setup can be refreshed from a verified package", () => {
    const profile = makeProfile(join(temp, "stale-broker-record-case"));
    const firstInstall = runPowerShell(installer, ["-PackagePath", zipPath, "-NoAutostart", "-NoLaunch"], { input: "y\n", env: profile.env });
    assert.equal(firstInstall.status, 0, firstInstall.stderr || firstInstall.stdout);
    const installedBroker = join(profile.m9rHome, "bin", "m9r-web-broker.exe");
    const runtimeManifest = JSON.parse(readFileSync(join(profile.m9rHome, "install-manifest.json"), "utf8"));
    assert.ok(runtimeManifest.runtimeFiles.some((path) => canonicalPath(path) === canonicalPath(installedBroker)));

    writeFileSync(installedBroker, Buffer.concat([readFileSync(installedBroker), Buffer.from("engine-updated-companion")]));
    const refreshed = runPowerShell(installer, ["-PackagePath", zipPath, "-NoAutostart", "-NoLaunch"], { input: "y\n", env: profile.env });
    assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
    assert.match(refreshed.stdout, /exact path is recorded by the M9R runtime manifest/i);
    assert.deepEqual(readFileSync(installedBroker), readFileSync(join(engineDist, "m9r-web-broker.exe")));
    const ownership = JSON.parse(readFileSync(join(profile.m9rHome, "web-broker-install.json"), "utf8"));
    assert.equal(ownership.sha256, createHash("sha256").update(readFileSync(installedBroker)).digest("hex"));
  });

  await t.test("uninstall preserves a web broker changed after installation", () => {
    const profile = makeProfile(join(temp, "modified-broker-case"));
    const installed = runPowerShell(installer, ["-PackagePath", zipPath, "-NoAutostart", "-NoLaunch"], { input: "y\n", env: profile.env });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const brokerPath = join(profile.m9rHome, "bin", "m9r-web-broker.exe");
    const ownershipPath = join(profile.m9rHome, "web-broker-install.json");
    writeFileSync(brokerPath, Buffer.concat([readFileSync(brokerPath), Buffer.from("user change")]));

    const uninstalled = runPowerShell(installer, ["-Uninstall"], { input: "y\n", env: profile.env });
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.match(uninstalled.stderr + uninstalled.stdout, /Keeping the web broker because it changed outside M9R setup/);
    assert.ok(existsSync(brokerPath), "uninstall must keep a modified broker binary");
    assert.ok(existsSync(ownershipPath), "the ownership record must remain so the preserved file is explainable");
  });

  await t.test("declining first-run consent changes no agent configuration or install path", () => {
    const profile = makeProfile(join(temp, "decline-case"));
    const result = runPowerShell(installer, ["-PackagePath", zipPath], { input: "n\n", env: profile.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Cancelled\. No agent configuration was changed\./);
    assert.equal(listFiles(profile.claude).length, 0);
    assert.equal(listFiles(profile.codex).length, 0);
    assert.equal(existsSync(profile.m9rHome), false);
  });

  await t.test("bad SHA-256 fails closed before touching profiles", () => {
    const corruptZip = join(temp, "corrupt.zip");
    cpSync(zipPath, corruptZip);
    writeFileSync(`${corruptZip}.sha256`, `${"0".repeat(64)}  m9r-engine-windows-x64.zip\n`);
    const profile = makeProfile(join(temp, "checksum-case"));
    const result = runPowerShell(installer, ["-PackagePath", corruptZip], { input: "y\n", env: profile.env });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /SHA-256 does not match/);
    assert.equal(existsSync(profile.m9rHome), false);
    assert.equal(listFiles(profile.claude).length, 0);
    assert.equal(listFiles(profile.codex).length, 0);
  });
});
