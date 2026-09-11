import assert from "node:assert/strict";
import test from "node:test";
import {
  autostartPlatform,
  buildScheduledTaskRegisterScript,
  buildScheduledTaskQueryScript,
  buildScheduledTaskRemoveScript,
  buildPowerShellArgs,
  buildLaunchAgentPlist,
  macosLaunchAgentPath,
  MACOS_LAUNCH_AGENT_LABEL,
  buildSystemdUnit,
  linuxSystemdUnitPath,
  LINUX_SYSTEMD_UNIT_NAME,
  buildCronLine,
  upsertCronEntry,
  removeCronEntry,
  LINUX_CRON_MARKER,
  WINDOWS_TASK_NAME,
  type AutostartLaunchSpec,
} from "@/lib/oathlock-autostart";

const posixSpec: AutostartLaunchSpec = {
  nodeExecutable: "/usr/local/bin/node",
  nodeArgs: ["--import", "file:///repo/scripts/register-alias.mjs"],
  cliEntryPath: "/repo/cli/dist/oathlock.js",
  args: ["terminal", "runtime"],
  workingDirectory: "/repo",
};

test("autostartPlatform maps each supported OS to its own mechanism and refuses the rest", () => {
  assert.equal(autostartPlatform("win32"), "windows");
  assert.equal(autostartPlatform("darwin"), "macos");
  assert.equal(autostartPlatform("linux"), "linux");
  assert.equal(autostartPlatform("freebsd"), "unsupported");
  assert.equal(autostartPlatform("aix"), "unsupported");
});

/* ------------------------------------------------------------------ Windows */

test("the Scheduled Task registration is per-user, hidden twice over, and time-unlimited -- a finite ExecutionTimeLimit would let Task Scheduler reap the detached runtime with the launcher", () => {
  const script = buildScheduledTaskRegisterScript('-WindowStyle Hidden -File "C:\\repo\\.oathlock\\service-launch.ps1"', "C:\\repo");
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User "\$env:USERDOMAIN\\\$env:USERNAME"/, "must trigger for the current user only, never machine-wide");
  assert.match(script, /New-ScheduledTaskSettingsSet -Hidden\b/, "task settings must mark the task hidden");
  assert.match(script, /-WindowStyle Hidden/, "the launched powershell action must itself be hidden");
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/, "no execution time limit");
  assert.doesNotMatch(script, /-RunLevel Highest|Register-ScheduledTask[^\n]*-User 'SYSTEM'/i, "must never ask for elevation");
});

test("Scheduled Task registration is idempotent by -Force, so a second init replaces rather than duplicates", () => {
  const script = buildScheduledTaskRegisterScript("-File x.ps1", "C:\\repo");
  assert.match(script, /Register-ScheduledTask -TaskName 'OathLock Runtime AutoStart'[\s\S]*-Force/);
  assert.equal(WINDOWS_TASK_NAME, "OathLock Runtime AutoStart");
});

test("single quotes inside a path cannot break out of the PowerShell literal", () => {
  const script = buildScheduledTaskRegisterScript("-File x", "C:\\o'brien'; Remove-Item C:\\");
  assert.match(script, /-WorkingDirectory 'C:\\o''brien''; Remove-Item C:\\'/);
});

test("the query and remove scripts tolerate an absent task instead of erroring", () => {
  assert.match(buildScheduledTaskQueryScript(), /-ErrorAction SilentlyContinue/);
  const remove = buildScheduledTaskRemoveScript();
  assert.match(remove, /-ErrorAction SilentlyContinue/, "must check for existence first");
  assert.match(remove, /Unregister-ScheduledTask -TaskName 'OathLock Runtime AutoStart' -Confirm:\$false/, "must not prompt");
});

test("PowerShell is always invoked hidden and non-interactive, so registration itself never flashes a window or blocks on a prompt", () => {
  const args = buildPowerShellArgs("Get-Date");
  assert.ok(args.includes("-WindowStyle") && args[args.indexOf("-WindowStyle") + 1] === "Hidden");
  assert.ok(args.includes("-NonInteractive"));
  assert.ok(args.includes("-NoProfile"));
  assert.equal(args[args.length - 1], "Get-Date", "the script must be the final -Command argument");
});

/* -------------------------------------------------------------------- macOS */

test("the macOS plist goes in the per-user LaunchAgents directory, never LaunchDaemons (which would need root)", () => {
  const path = macosLaunchAgentPath("/Users/kai");
  assert.equal(path, "/Users/kai/Library/LaunchAgents/com.oathlock.runtime.plist");
  assert.doesNotMatch(path, /LaunchDaemons/);
});

test("the LaunchAgent plist is well-formed and carries node flags, entry path and args in launch order", () => {
  const plist = buildLaunchAgentPlist(posixSpec, "/repo/.oathlock/launch-agent.log");
  assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(plist, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
  assert.ok(plist.trimEnd().endsWith("</plist>"));
  assert.equal((plist.match(/<dict>/g) ?? []).length, (plist.match(/<\/dict>/g) ?? []).length);
  const order = [
    "/usr/local/bin/node",
    "file:///repo/scripts/register-alias.mjs",
    "/repo/cli/dist/oathlock.js",
    "<string>terminal</string>",
    "<string>runtime</string>",
  ].map((needle) => plist.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), "every launch argument must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "launch arguments must stay in order");
});

test("the LaunchAgent runs at load, in the background, from the repo directory", () => {
  const plist = buildLaunchAgentPlist(posixSpec, "/repo/.oathlock/launch-agent.log");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*\n\s*<true\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*\n\s*<string>Background<\/string>/, "Background keeps it off the Dock and out of the GUI");
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*\n\s*<string>\/repo<\/string>/);
  assert.match(plist, new RegExp(`<string>${MACOS_LAUNCH_AGENT_LABEL}</string>`));
});

test("plist values are XML-escaped, so an & or < in a repo path cannot produce an unparsable plist", () => {
  const plist = buildLaunchAgentPlist({ ...posixSpec, workingDirectory: "/Users/a&b/<repo>" }, "/log");
  assert.match(plist, /<string>\/Users\/a&amp;b\/&lt;repo&gt;<\/string>/);
  assert.doesNotMatch(plist, /<string>[^<]*[&][^a-z#]/);
});

/* -------------------------------------------------------------------- Linux */

test("the systemd unit is a user unit wanted by default.target -- never a system unit and never root", () => {
  const unitPath = linuxSystemdUnitPath("/home/kai");
  assert.equal(unitPath, "/home/kai/.config/systemd/user/oathlock-runtime.service");
  assert.equal(LINUX_SYSTEMD_UNIT_NAME, "oathlock-runtime.service");
  const unit = buildSystemdUnit(posixSpec);
  assert.match(unit, /^\[Install\]\nWantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /WantedBy=multi-user\.target/, "multi-user.target is a system-manager target");
  assert.doesNotMatch(unit, /^User=/m, "a user unit must not try to set a User=");
});

test("the systemd unit's ExecStart is absolute, quoted, and in launch order", () => {
  const unit = buildSystemdUnit(posixSpec);
  const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
  assert.ok(execStart);
  assert.equal(
    execStart,
    'ExecStart="/usr/local/bin/node" "--import" "file:///repo/scripts/register-alias.mjs" "/repo/cli/dist/oathlock.js" "terminal" "runtime"',
  );
  assert.match(unit, /^WorkingDirectory=\/repo$/m);
  assert.match(unit, /^Type=simple$/m);
});

test("the cron fallback line runs at reboot, from the repo, silently, and is marker-tagged for removal", () => {
  const line = buildCronLine(posixSpec);
  assert.ok(line.startsWith("@reboot cd '/repo' && "));
  assert.match(line, />\/dev\/null 2>&1/);
  assert.ok(line.endsWith(LINUX_CRON_MARKER));
});

test("upsertCronEntry preserves unrelated crontab lines and never accumulates duplicates across repeated inits", () => {
  const existing = "MAILTO=me\n0 3 * * * /usr/bin/backup\n";
  const line = buildCronLine(posixSpec);
  const once = upsertCronEntry(existing, line);
  const twice = upsertCronEntry(once, line);
  assert.equal(once, twice, "re-running init must be a no-op on the crontab");
  assert.equal(twice.split("\n").filter((entry) => entry.includes(LINUX_CRON_MARKER)).length, 1);
  assert.ok(twice.includes("MAILTO=me") && twice.includes("0 3 * * * /usr/bin/backup"));
  assert.ok(twice.endsWith("\n"), "a crontab must end with a newline or crontab(1) rejects the last line");
});

test("removeCronEntry strips only the OathLock line and leaves a valid crontab behind", () => {
  const withEntry = upsertCronEntry("0 3 * * * /usr/bin/backup\n", buildCronLine(posixSpec));
  const cleaned = removeCronEntry(withEntry);
  assert.equal(cleaned, "0 3 * * * /usr/bin/backup\n");
  assert.equal(removeCronEntry(cleaned), cleaned, "removal is idempotent");
  assert.equal(removeCronEntry(""), "");
});
