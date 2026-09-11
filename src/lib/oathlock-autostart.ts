/**
 * Cross-platform "start the OathLock runtime when the user logs in"
 * registration, used by `oathlock init` (install) and `oathlock disconnect`
 * (removal).
 *
 * Every mechanism here is deliberately USER-LEVEL: a per-user Scheduled Task
 * on Windows, a LaunchAgent (never a LaunchDaemon) on macOS, and
 * `systemctl --user` (never system-wide) on Linux, with a per-user `@reboot`
 * crontab entry as the fallback where systemd is absent. Nothing in this file
 * may require admin/root/sudo, and nothing may put a visible window on screen
 * -- not at registration time and not at every future login.
 *
 * This module is pure string/plan building so the generated artifacts (task
 * XML arguments, plist, unit file, cron line) can be unit-tested on any OS.
 * The actual process execution lives in scripts/oathlock-cli.ts.
 *
 * Windows note: the repo already ships an HKCU\...\Run launcher
 * (src/lib/oathlock-windows-service.ts) that exists because `schtasks.exe
 * /create /sc onlogon` was denied by this machine's security stack. The
 * PowerShell `Register-ScheduledTask` cmdlet path below was since verified to
 * register and fire cleanly on the same hardware, so it is now preferred --
 * but the Run key stays as the automatic fallback when task registration is
 * refused, and the caller removes whichever one it did not install so a login
 * never launches the runtime twice.
 */

export type AutostartPlatform = "windows" | "macos" | "linux" | "unsupported";

export function autostartPlatform(nodePlatform: NodeJS.Platform): AutostartPlatform {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "linux") return "linux";
  return "unsupported";
}

/**
 * How to relaunch this CLI. `nodeArgs` carries the flags a raw .ts entry needs
 * (`--import register-alias.mjs`); a packaged cli/dist entry needs none. See
 * the long note in oathlock-windows-service.ts -- dropping them does not make
 * a smaller launcher, it makes one that dies on its first import with no
 * console to report it in.
 */
export interface AutostartLaunchSpec {
  nodeExecutable: string;
  nodeArgs: string[];
  cliEntryPath: string;
  args: string[];
  workingDirectory: string;
}

/* ------------------------------------------------------------------ Windows */

export const WINDOWS_TASK_NAME = "OathLock Runtime AutoStart";

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell that registers the logon task. Two independent things keep a
 * window off the screen, because either one alone has been observed to flash:
 * `-WindowStyle Hidden` on the powershell action itself, and `-Hidden` in the
 * task settings.
 *
 * `ExecutionTimeLimit` is explicitly unlimited ([TimeSpan]::Zero). The action
 * script detaches the real runtime with Start-Process and then exits, but Task
 * Scheduler enforces its time limit by terminating the task's process tree --
 * a finite limit risks reaping the detached runtime along with the launcher.
 *
 * `-Force` is what makes this idempotent: re-running `init` replaces the
 * single registration in place instead of ever creating a second one.
 */
export function buildScheduledTaskRegisterScript(launcherCommandArguments: string, workingDirectory: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(launcherCommandArguments)} -WorkingDirectory ${psQuote(workingDirectory)}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User \"$env:USERDOMAIN\\$env:USERNAME\"",
    "$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable",
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join("\n");
}

export function buildScheduledTaskQueryScript(): string {
  return `if (Get-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue) { 'installed' } else { 'absent' }`;
}

export function buildScheduledTaskRemoveScript(): string {
  return [
    `if (Get-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue) {`,
    `  Unregister-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -Confirm:$false`,
    "}",
  ].join("\n");
}

/** Arguments for running a PowerShell snippet from Node without a new window. */
export function buildPowerShellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script];
}

/* -------------------------------------------------------------------- macOS */

export const MACOS_LAUNCH_AGENT_LABEL = "com.oathlock.runtime";

export function macosLaunchAgentPath(homeDirectory: string): string {
  return `${homeDirectory}/Library/LaunchAgents/${MACOS_LAUNCH_AGENT_LABEL}.plist`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A user LaunchAgent, not a LaunchDaemon: it lives in ~/Library/LaunchAgents,
 * loads into the per-user GUI domain, and never asks for sudo. `ProcessType
 * Background` plus the fact that node is not a GUI app means launchd gives it
 * no window and no Dock presence.
 *
 * `KeepAlive` is intentionally absent (defaults to false): the runtime has its
 * own watchdog, and launchd respawning it in a tight loop would fight that.
 */
export function buildLaunchAgentPlist(spec: AutostartLaunchSpec, logPath: string): string {
  const programArguments = [spec.nodeExecutable, ...spec.nodeArgs, spec.cliEntryPath, ...spec.args];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(MACOS_LAUNCH_AGENT_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((argument) => `    <string>${xmlEscape(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(spec.workingDirectory)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------- Linux */

export const LINUX_SYSTEMD_UNIT_NAME = "oathlock-runtime.service";

export function linuxSystemdUnitPath(homeDirectory: string): string {
  return `${homeDirectory}/.config/systemd/user/${LINUX_SYSTEMD_UNIT_NAME}`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A `systemctl --user` unit wanted by default.target: it starts when this
 * user's systemd session starts (login) and never touches the system manager,
 * so no root is involved.
 */
export function buildSystemdUnit(spec: AutostartLaunchSpec): string {
  const execStart = [spec.nodeExecutable, ...spec.nodeArgs, spec.cliEntryPath, ...spec.args].map(systemdQuote).join(" ");
  return [
    "[Unit]",
    "Description=M9R Runtime (local terminal bridge)",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.workingDirectory}`,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Marker comment that makes the cron fallback entry findable for removal. */
export const LINUX_CRON_MARKER = "# oathlock-runtime-autostart";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildCronLine(spec: AutostartLaunchSpec): string {
  const command = [spec.nodeExecutable, ...spec.nodeArgs, spec.cliEntryPath, ...spec.args].map(shellQuote).join(" ");
  return `@reboot cd ${shellQuote(spec.workingDirectory)} && ${command} >/dev/null 2>&1 ${LINUX_CRON_MARKER}`;
}

/**
 * Rewrites an existing crontab so it contains exactly one OathLock entry,
 * leaving every unrelated line untouched. Running `init` repeatedly must never
 * grow the crontab.
 */
export function upsertCronEntry(existingCrontab: string, line: string): string {
  const kept = removeCronEntry(existingCrontab).replace(/\n+$/, "");
  return (kept ? `${kept}\n` : "") + line + "\n";
}

export function removeCronEntry(existingCrontab: string): string {
  const kept = existingCrontab
    .split("\n")
    .filter((entry) => !entry.includes(LINUX_CRON_MARKER));
  const joined = kept.join("\n").replace(/\n+$/, "");
  return joined ? `${joined}\n` : "";
}
