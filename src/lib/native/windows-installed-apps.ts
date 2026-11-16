import { execFile } from "node:child_process";
import { join, isAbsolute } from "node:path";

export interface InstalledWindowsApp {
  executable: string;
  args: string[];
  windowExecutable?: string;
  /** Exact process image path for packaged apps that own their HWND directly. */
  windowExecutablePath?: string;
  /** Exact AppsFolder identity used to distinguish generic frame-host HWNDs. */
  appUserModelId?: string;
}

const APP_ALIASES: Record<string, readonly string[]> = {
  chrome: ["chrome", "Google Chrome"],
  "google chrome": ["chrome", "Google Chrome"],
  edge: ["edge", "Microsoft Edge", "msedge"],
  "microsoft edge": ["edge", "Microsoft Edge", "msedge"],
  explorer: ["explorer", "File Explorer", "Windows Explorer"],
  "file explorer": ["explorer", "File Explorer", "Windows Explorer"],
  // Windows 11 registers the modern packaged editor as either "Notepad" or
  // "Windows Notepad" depending on the installed package generation. Keep
  // the explicit legacy executable fallback below; this only broadens the
  // StartApps names considered before that fallback is selected.
  notepad: ["Notepad", "Windows Notepad"],
  "windows notepad": ["Notepad", "Windows Notepad"],
  powershell: ["powershell", "Windows PowerShell", "PowerShell"],
  "windows powershell": ["powershell", "Windows PowerShell", "PowerShell"],
};

const WINDOWS_TERMINAL_NAMES = new Set(["terminal", "windowsterminal", "wt"]);
const WINDOWS_TERMINAL_REGISTERED_NAME = "Terminal";

// APP_ALIASES' own keys (e.g. "google chrome", "windows notepad") are raw,
// space-containing strings, but windowsAppSearchNames() looks them up by the
// same stripped/lowercased key (appNameKey) it uses for everything else --
// which never contains a space. A lookup by that stripped key against these
// raw multi-word keys always misses; only the single-word keys ("chrome",
// "edge") ever matched this way. The exact-raw-lowercase fallback below used
// to paper over the common case ("Google Chrome" typed exactly), but any
// other spacing or punctuation ("GoogleChrome", "google  chrome",
// "google-chrome") resolved zero aliases and fell straight through to
// whatever direct/PATH executable happened to match the literal name -- the
// exact legacy-compatibility-stub problem this alias table exists to avoid
// (see resolveStageLaunchApp's comment on Notepad). Normalize the alias
// table's own keys the same way once, so every alias matches regardless of
// how its name is spaced or punctuated, not just an exact literal copy.
const NORMALIZED_APP_ALIASES = new Map<string, readonly string[]>(
  Object.entries(APP_ALIASES).map(([aliasKey, names]) => [appNameKey(aliasKey), names]),
);

/** Resolve compatibility launchers through Windows' installed app metadata.
 * No per-app renderer aliases, title substring guesses, or unrelated fresh HWNDs.
 * Data crosses the PowerShell boundary only through an environment variable.
 */
export const WINDOWS_RENDERER_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$launcher = Get-Item -LiteralPath $env:M9R_APP_LAUNCHER
function Key([string] $value) { ($value.ToLowerInvariant() -replace '\.exe$', '' -replace '[^\p{L}\p{N}]', '') }
$description = [string] $launcher.VersionInfo.FileDescription
$names = @($launcher.BaseName, $description)
# Windows compatibility stubs commonly retain the OS brand in FileDescription
# while StartApps exposes the same registered product without that brand.
if ($description -match '^Windows\s+(.+)$') { $names += $Matches[1] }
$keys = @($names | Where-Object { $_ } | ForEach-Object { Key $_ })
$shell = New-Object -ComObject Shell.Application
$item = $shell.Namespace($launcher.DirectoryName).ParseName($launcher.Name)
$aumid = if ($env:M9R_APP_AUMID) { $env:M9R_APP_AUMID } else { [string] $item.ExtendedProperty('System.AppUserModel.ID') }
$found = @()
foreach ($app in @(Get-StartApps | Where-Object { if ($env:M9R_APP_AUMID) { $_.AppID -eq $aumid } else { ($keys -contains (Key $_.Name)) -or ($aumid -and $_.AppID -eq $aumid) } })) {
  if ($app.AppID -notmatch '^([^!]+)!([^!]+)$') { continue }
  $family = $Matches[1]; $id = $Matches[2]
  $packageName = $family.Substring(0, $family.LastIndexOf('_'))
  foreach ($package in @(Get-AppxPackage -Name $packageName | Where-Object PackageFamilyName -eq $family)) {
    $manifest = $package | Get-AppxPackageManifest
    foreach ($entry in @($manifest.Package.Applications.Application | Where-Object Id -eq $id)) {
      if ($entry.Executable) { $found += [IO.Path]::GetFullPath((Join-Path $package.InstallLocation ([string] $entry.Executable))) }
    }
  }
}
ConvertTo-Json -InputObject @($found | Sort-Object -Unique) -Compress
`;

/**
 * Both discovery lookups in this file spawn a cold PowerShell process and walk
 * Windows' package/shortcut inventory -- real cost (seconds, sometimes the full
 * 15s timeout) paid on every single app launch, for every app, with nothing
 * about installed apps having changed since the last lookup. Cache by the
 * exact query key for a bounded time so repeat launches of the same app (the
 * overwhelmingly common case) skip the scan entirely; a real install/uninstall
 * mid-session is picked up again once the entry expires. Only the real
 * (non-test) query path is cached -- a caller passing its own `query` is
 * always an injected test fixture, and caching would make one test's fixture
 * answer a later test's differently-fixtured call for the same name.
 */
const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
interface DiscoveryCacheEntry<T> { readonly value?: T; readonly error?: Error; readonly expiresAt: number; }
const windowExecutableCache = new Map<string, DiscoveryCacheEntry<string>>();
const installedAppCache = new Map<string, DiscoveryCacheEntry<InstalledWindowsApp>>();

export async function discoverInstalledWindowExecutable(executable: string,
  query?: (script: string, env: Record<string, string>) => Promise<string>,
  appUserModelId?: string): Promise<string | undefined> {
  if (!query && process.platform !== "win32") return undefined;
  const cacheKey = query ? undefined : `${executable.toLowerCase()}\0${appUserModelId ?? ""}`;
  if (cacheKey) {
    const cached = windowExecutableCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
  }
  const run = query ?? ((script: string, env: Record<string, string>) => new Promise<string>((resolve, reject) => {
    execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, env: { ...process.env, ...env } },
      (error, stdout) => error ? reject(new Error("Windows renderer identity lookup failed; no mismatched window was adopted.")) : resolve(stdout));
  }));
  try {
    const parsed: unknown = JSON.parse((await run(WINDOWS_RENDERER_DISCOVERY_SCRIPT, { M9R_APP_LAUNCHER: executable,
      M9R_APP_AUMID: appUserModelId ?? "" })).replace(/^\uFEFF/, ""));
    const result = !Array.isArray(parsed) || parsed.some((path) => typeof path !== "string" || !isAbsolute(path) || !/\.exe$/i.test(path))
      ? undefined
      : (() => {
        const paths = [...new Map((parsed as string[]).map((path) => [path.toLowerCase(), path])).values()];
        return paths.length === 1 ? paths[0] : undefined;
      })();
    if (cacheKey) windowExecutableCache.set(cacheKey, { value: result, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
    return result;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (cacheKey) windowExecutableCache.set(cacheKey, { error: normalized, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
    throw normalized;
  }
}

function appNameKey(value: string): string {
  return value.toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]/gu, "");
}

/** Windows registers friendly app names differently from common task phrasing. */
export function windowsAppSearchNames(value: string): string[] {
  const key = appNameKey(value.trim());
  // Resolve these aliases to the packaged app's exact registered name. The
  // generic "terminal" and "wt" searches also find unrelated registrations,
  // turning one ordinary Windows Terminal request into a false ambiguity.
  if (WINDOWS_TERMINAL_NAMES.has(key)) return [WINDOWS_TERMINAL_REGISTERED_NAME];
  const aliases = NORMALIZED_APP_ALIASES.get(key);
  const candidates = [value.trim(), ...(aliases ?? [])].filter(Boolean);
  return [...new Map(candidates.map((candidate) => [appNameKey(candidate), candidate])).values()];
}

// Read Windows' own registrations and user shortcuts. The requested name is
// data in an environment variable, never interpolated into PowerShell code.
export const WINDOWS_APP_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Key([string] $value) { ($value.ToLowerInvariant() -replace '\.exe$', '' -replace '[^\p{L}\p{N}]', '') }
$queryKeys = @((ConvertFrom-Json -InputObject $env:M9R_APP_QUERY_NAMES) | ForEach-Object { Key ([string] $_) })
function Matches([string] $value) { $queryKeys -contains (Key $value) }
$found = @()
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
  foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
    if (Matches $key.PSChildName) {
      $target = $key.GetValue('')
      if ($target -and (Test-Path -LiteralPath $target)) { $found += @{ executable = $target; args = @() } }
    }
  }
}
# Packaged apps have exact registered names and stable activation IDs; the
# AppUserModelId alone is enough for window matching in the common case (see
# stageWindowMatchesApp). Resolving the exact executable via Get-AppxPackage |
# Get-AppxPackageManifest is a real cost (COM calls, manifest XML parsing) that
# only earns its keep when there's an actual ambiguity to resolve: a legacy App
# Paths compatibility stub also registered for this name, or more than one
# packaged match. Everything else gets the AUMID for free and skips it; the
# rare window that truly has no AUMID (for example, current Notepad's own
# HWND) still gets resolved later by the lazy renderer lookup in
# task-desktop-stage.ts, which calls discoverInstalledWindowExecutable only
# when the cheap AUMID match actually fails.
$packagedMatches = @(Get-StartApps | Where-Object { Matches $_.Name })
$needsExactIdentity = ($found.Count -gt 0) -or ($packagedMatches.Count -gt 1)
foreach ($app in $packagedMatches) {
  if ($app.AppID -notmatch '^([^!]+)!([^!]+)$') { continue }
  $family = $Matches[1]; $id = $Matches[2]
  if (-not $needsExactIdentity) {
    $found += @{ executable = (Join-Path $env:SystemRoot 'explorer.exe'); args = @('shell:AppsFolder\' + $app.AppID); appUserModelId = [string] $app.AppID }
    continue
  }
  $packageName = $family.Substring(0, $family.LastIndexOf('_'))
  $package = Get-AppxPackage -Name $packageName | Where-Object PackageFamilyName -eq $family | Select-Object -First 1
  if (-not $package) { continue }
  $manifest = $package | Get-AppxPackageManifest
  $entry = $manifest.Package.Applications.Application | Where-Object Id -eq $id | Select-Object -First 1
  if (-not $entry.Executable) { continue }
  $found += @{ executable = (Join-Path $env:SystemRoot 'explorer.exe'); args = @('shell:AppsFolder\' + $app.AppID); windowExecutable = [IO.Path]::GetFileName($entry.Executable); windowExecutablePath = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation ([string] $entry.Executable))); appUserModelId = [string] $app.AppID }
}
if ($found.Count -gt 0) {
  ConvertTo-Json -InputObject @($found) -Compress -Depth 3
  exit 0
}
$shell = New-Object -ComObject WScript.Shell
$roots = @()
if ($env:APPDATA) { $roots += Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar' }
$roots += @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
foreach ($root in $roots) {
  if (-not $root) { continue }
  foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue)) {
    $link = $shell.CreateShortcut($file.FullName)
    if (-not (Matches $file.BaseName) -and -not (Matches ([IO.Path]::GetFileName($link.TargetPath)))) { continue }
    if ($link.TargetPath -match '\.exe$' -and (Test-Path -LiteralPath $link.TargetPath)) {
      if ($link.Arguments) {
        $found += @{ executable = (Join-Path $env:SystemRoot 'explorer.exe'); args = @($file.FullName); windowExecutable = [IO.Path]::GetFileName($link.TargetPath) }
      } else { $found += @{ executable = $link.TargetPath; args = @() } }
    }
  }
}
ConvertTo-Json -InputObject @($found) -Compress -Depth 3
`;

export async function discoverInstalledWindowsApp(
  name: string,
  query?: (script: string, env: Record<string, string>) => Promise<string>,
): Promise<InstalledWindowsApp | undefined> {
  if (!query && process.platform !== "win32") return undefined;
  const cacheKey = query ? undefined : appNameKey(name.trim());
  if (cacheKey) {
    const cached = installedAppCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
  }
  try {
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = { M9R_APP_QUERY_NAMES: JSON.stringify(windowsAppSearchNames(name)) };
    const output = query
      ? await query(WINDOWS_APP_DISCOVERY_SCRIPT, env)
      : await new Promise<string>((resolve, reject) => {
        execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_APP_DISCOVERY_SCRIPT], {
          windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024,
          env: { ...process.env, ...env },
        }, (error, stdout, stderr) => error ? reject(new Error(`Windows app discovery failed: ${error.killed ? "Windows inventory query exceeded its 15-second deadline." : (stderr.trim() || error.message.split("\n")[0]).slice(0, 500)}`)) : resolve(stdout));
      });
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) throw new Error("Windows app discovery returned an invalid inventory.");
    const apps = parsed.filter((app): app is InstalledWindowsApp => app && typeof app.executable === "string"
      && isAbsolute(app.executable) && /\.exe$/i.test(app.executable) && Array.isArray(app.args)
      && (app.args.length === 0 || (app.args.length === 1 && typeof app.args[0] === "string"
        && (/^shell:AppsFolder\\[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(app.args[0]) || (isAbsolute(app.args[0]) && /\.lnk$/i.test(app.args[0]) && !/[\u0000-\u001f]/.test(app.args[0])))))
      && (app.windowExecutable === undefined || /^[^\\/]+\.exe$/i.test(app.windowExecutable))
      && (app.windowExecutablePath === undefined || (isAbsolute(app.windowExecutablePath) && /\.exe$/i.test(app.windowExecutablePath)))
      && (app.appUserModelId === undefined || /^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(app.appUserModelId)));
    const unique = [...new Map(apps.map((app) => [`${app.executable.toLowerCase()}\0${app.args.join("\0")}`, app])).values()];
    const packaged = unique.filter((app) => app.args[0]?.startsWith("shell:AppsFolder\\"));
    // Windows ships compatibility stubs beside the registered packaged app
    // (Notepad is one example). These are two launch routes for the same app.
    const resolved = packaged.length === 1 && unique.every((app) => app === packaged[0]
      || [packaged[0].windowExecutablePath?.split(/[\\/]/).at(-1), packaged[0].windowExecutable]
        .some((winName) => typeof winName === "string" && app.executable.split(/[\\/]/).at(-1)?.toLowerCase() === winName.toLowerCase()))
      ? packaged[0]
      : unique.length > 1
        ? (() => {
          const candidates = unique.slice(0, 10).map((app) => app.executable).join("; ");
          throw new Error(`Windows found multiple installed apps named "${name}" (${candidates}); select the intended app.`);
        })()
        : unique[0];
    if (cacheKey) installedAppCache.set(cacheKey, { value: resolved, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
    return resolved;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (cacheKey) installedAppCache.set(cacheKey, { error: normalized, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
    throw normalized;
  }
}
