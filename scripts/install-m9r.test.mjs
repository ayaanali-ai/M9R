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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const installer = resolve("scripts/install-m9r.ps1");
const engineDist = resolve("engine/dist");
const powershell = process.env.M9R_TEST_PWSH ?? "pwsh";
const canRunNativeInstaller = process.platform === "win32"
  && ["m9r-engine.exe", "m9r-hook.exe"].every((name) => existsSync(join(engineDist, name)));
const skipNative = canRunNativeInstaller ? false : "Windows engine binaries are required (CI builds them first).";

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
  const stage = join(directory, "package");
  mkdirSync(stage);
  for (const file of ["m9r-engine.exe", "m9r-hook.exe"]) {
    cpSync(join(engineDist, file), join(stage, file));
  }
  cpSync(installer, join(stage, "install-m9r.ps1"));
  writeFileSync(join(stage, "INSTALLATION.txt"), "M9R Windows standalone installer test package\n");
  const zipPath = join(directory, "m9r-engine-windows-x64.zip");
  const zipScript = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$stage = '${stage.replaceAll("'", "''")}'`,
    `$zip = '${zipPath.replaceAll("'", "''")}'`,
    "[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Fastest, $false)",
  ].join("\n");
  const zipResult = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(zipScript, "utf16le").toString("base64")], {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (zipResult.error) throw zipResult.error;
  assert.equal(zipResult.status, 0, zipResult.stderr || zipResult.stdout);
  const digest = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(`${zipPath}.sha256`, `${digest}  m9r-engine-windows-x64.zip\n`);
  return zipPath;
}

function makeProfile(parent) {
  const profile = join(parent, "profile");
  const claude = join(parent, "claude-config");
  const codex = join(parent, "codex-home");
  mkdirSync(profile, { recursive: true });
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return {
    profile,
    claude,
    codex,
    env: {
      ...process.env,
      USERPROFILE: profile,
      HOME: profile,
      HOMEDRIVE: profile.slice(0, 2),
      HOMEPATH: profile.slice(2),
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

test("installer contains no Node/npm dependency and does not bypass PowerShell policy", () => {
  const source = readFileSync(installer, "utf8");
  assert.doesNotMatch(source, /(?:&\s*|Get-Command\s+)(?:npm|node)(?:\.exe)?\b/i);
  assert.doesNotMatch(source, /ExecutionPolicy\s+Bypass|Invoke-Expression|\biex\b/i);
  assert.match(source, /Get-FileHash[\s\S]*SHA256/);
  assert.match(source, /setup --dry-run/);
  assert.match(source, /setup --yes/);
  assert.match(source, /maintenanceExe uninstall/);
});

test("standalone package consent, setup, integrity, and uninstall paths", { skip: skipNative }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "m9r-real-installer-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const zipPath = createPackage(temp);

  await t.test("one explicit approval installs the actual engine; uninstall works from a maintenance copy", async () => {
    const profile = makeProfile(join(temp, "install-case"));
    const originalFiles = new Map([
      [join(profile.claude, "settings.json"), '{"userSetting":true}\n'],
      [join(profile.claude, "CLAUDE.md"), "# User-authored Claude instructions\n"],
      [join(profile.codex, "config.toml"), "# User-authored Codex config\n"],
      [join(profile.codex, "AGENTS.md"), "# User-authored Codex instructions\n"],
    ]);
    for (const [path, contents] of originalFiles) writeFileSync(path, contents);
    const installed = runPowerShell(installer, ["-PackagePath", zipPath], { input: "y\n", env: profile.env });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.match(installed.stdout, /M9R FIRST-RUN CONSENT/);
    assert.match(installed.stdout, /Exact setup plan from the engine/);
    assert.match(installed.stdout, /m9r-engine uninstall/);
    assert.ok(existsSync(join(profile.profile, ".m9r", "bin", "m9r-engine.exe")));
    assert.ok(existsSync(join(profile.profile, ".m9r", "bin", "m9r-hook.exe")));
    assert.ok(listFiles(profile.claude).some((file) => /settings\.json$/i.test(file)));
    assert.ok(listFiles(profile.codex).some((file) => /config\.toml$/i.test(file)));

    const uninstalled = runPowerShell(installer, ["-Uninstall"], { input: "y\n", env: profile.env });
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    assert.match(uninstalled.stdout, /M9R setup was removed/);
    assert.match(uninstalled.stdout, /M9R uninstall will:/);
    assert.equal(existsSync(join(profile.profile, ".m9r", "bin", "m9r-engine.exe")), false);
    assert.equal(existsSync(join(profile.profile, ".m9r", "bin", "m9r-hook.exe")), false);
    for (const [path, contents] of originalFiles) assert.equal(readFileSync(path, "utf8"), contents, `${path} must be restored exactly`);
  });

  await t.test("declining first-run consent changes no agent configuration or install path", () => {
    const profile = makeProfile(join(temp, "decline-case"));
    const result = runPowerShell(installer, ["-PackagePath", zipPath], { input: "n\n", env: profile.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Cancelled\. No agent configuration was changed\./);
    assert.equal(listFiles(profile.claude).length, 0);
    assert.equal(listFiles(profile.codex).length, 0);
    assert.equal(existsSync(join(profile.profile, ".m9r")), false);
  });

  await t.test("bad SHA-256 fails closed before touching profiles", () => {
    const corruptZip = join(temp, "corrupt.zip");
    cpSync(zipPath, corruptZip);
    writeFileSync(`${corruptZip}.sha256`, `${"0".repeat(64)}  m9r-engine-windows-x64.zip\n`);
    const profile = makeProfile(join(temp, "checksum-case"));
    const result = runPowerShell(installer, ["-PackagePath", corruptZip], { input: "y\n", env: profile.env });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /SHA-256 does not match/);
    assert.equal(existsSync(join(profile.profile, ".m9r")), false);
    assert.equal(listFiles(profile.claude).length, 0);
    assert.equal(listFiles(profile.codex).length, 0);
  });
});
