import { execFile } from "node:child_process";
import { join, isAbsolute } from "node:path";

export interface InstalledWindowsApp {
  executable: string;
  args: string[];
  windowExecutable?: string;
}

// Read Windows' own registrations and user shortcuts. The requested name is
// data in an environment variable, never interpolated into PowerShell code.
const DISCOVER = String.raw`
$ErrorActionPreference = 'Stop'
function Key([string] $value) { ($value.ToLowerInvariant() -replace '\.exe$', '' -replace '[^\p{L}\p{N}]', '') }
$query = Key $env:M9R_APP_QUERY
$found = @()
$shell = New-Object -ComObject WScript.Shell
$roots = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
foreach ($root in $roots) {
  if (-not $root) { continue }
  foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue)) {
    if ((Key $file.BaseName) -ne $query) { continue }
    $link = $shell.CreateShortcut($file.FullName)
    if ((Key $file.BaseName) -ne $query -and (Key ([IO.Path]::GetFileName($link.TargetPath))) -ne $query) { continue }
    if ($link.TargetPath -match '\.exe$' -and (Test-Path -LiteralPath $link.TargetPath)) {
      if ($link.Arguments) {
        $found += @{ executable = (Join-Path $env:SystemRoot 'explorer.exe'); args = @($file.FullName); windowExecutable = [IO.Path]::GetFileName($link.TargetPath) }
      } else { $found += @{ executable = $link.TargetPath; args = @() } }
    }
  }
}
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
  foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
    if ((Key $key.PSChildName) -eq $query) {
      $target = $key.GetValue('')
      if ($target -and (Test-Path -LiteralPath $target)) { $found += @{ executable = $target; args = @() } }
    }
  }
}
# Packaged apps must be activated through their registered identity, rather
# than executing a private binary from WindowsApps directly.
foreach ($app in @(Get-StartApps | Where-Object { (Key $_.Name) -eq $query })) {
  if ($app.AppID -notmatch '^([^!]+)!([^!]+)$') { continue }
  $family = $Matches[1]; $id = $Matches[2]
  $packageName = $family.Substring(0, $family.LastIndexOf('_'))
  $package = Get-AppxPackage -Name $packageName | Where-Object PackageFamilyName -eq $family | Select-Object -First 1
  if (-not $package) { continue }
  $manifest = $package | Get-AppxPackageManifest
  $entry = $manifest.Package.Applications.Application | Where-Object Id -eq $id | Select-Object -First 1
  if (-not $entry.Executable) { continue }
  $found += @{ executable = (Join-Path $env:SystemRoot 'explorer.exe'); args = @('shell:AppsFolder\' + $app.AppID); windowExecutable = [IO.Path]::GetFileName($entry.Executable) }
}
ConvertTo-Json -InputObject @($found) -Compress -Depth 3
`;

export async function discoverInstalledWindowsApp(name: string): Promise<InstalledWindowsApp | undefined> {
  if (process.platform !== "win32") return undefined;
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DISCOVER], {
      windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, M9R_APP_QUERY: name },
    }, (error, stdout, stderr) => error ? reject(new Error(`Windows app discovery failed: ${error.killed ? "Windows inventory query exceeded its 15-second deadline." : (stderr.trim() || error.message.split("\n")[0]).slice(0, 500)}`)) : resolve(stdout));
  });
  const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed)) throw new Error("Windows app discovery returned an invalid inventory.");
  const apps = parsed.filter((app): app is InstalledWindowsApp => app && typeof app.executable === "string"
    && isAbsolute(app.executable) && /\.exe$/i.test(app.executable) && Array.isArray(app.args)
    && (app.args.length === 0 || (app.args.length === 1 && typeof app.args[0] === "string"
      && (/^shell:AppsFolder\\[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(app.args[0]) || (isAbsolute(app.args[0]) && /\.lnk$/i.test(app.args[0]) && !/[\u0000-\u001f]/.test(app.args[0])))))
    && (app.windowExecutable === undefined || /^[^\\/]+\.exe$/i.test(app.windowExecutable)));
  const unique = [...new Map(apps.map((app) => [`${app.executable.toLowerCase()}\0${app.args.join("\0")}`, app])).values()];
  const packaged = unique.filter((app) => app.args[0]?.startsWith("shell:AppsFolder\\"));
  // Windows ships compatibility stubs beside the registered packaged app
  // (Notepad is one example). These are two launch routes for the same app.
  if (packaged.length === 1 && unique.every((app) => app === packaged[0]
    || app.executable.split(/[\\/]/).at(-1)?.toLowerCase() === packaged[0].windowExecutable!.toLowerCase())) return packaged[0];
  if (unique.length > 1) throw new Error(`Windows found multiple installed apps named "${name}"; select the intended app.`);
  return unique[0];
}
