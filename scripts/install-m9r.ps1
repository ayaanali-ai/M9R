<#
.SYNOPSIS
Installs the self-contained M9R Windows engine and runs its consent-driven setup.

.DESCRIPTION
No Node.js, npm, administrator rights, or execution-policy bypass is required.
The script downloads only a versioned GitHub release asset, verifies its SHA-256
sidecar, previews the engine's exact setup plan, then asks once before writing.

.PARAMETER Version
An exact release version such as 0.1.0. Defaults to the latest m9r-engine-v* release.

.PARAMETER PackagePath
Use a previously downloaded release ZIP. Its adjacent .sha256 file is required.

.PARAMETER Uninstall
Run the installed engine's reversible uninstall. It runs from a temporary copy
because Windows does not allow a process to delete its own executable.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$PackagePath,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'ayaanali-ai/M9R'
$assetName = 'm9r-engine-windows-x64.zip'
$checksumName = "$assetName.sha256"
$releaseTagPrefix = 'm9r-engine-v'

function Assert-M9rWindows {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'The standalone installer currently supports Windows only.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'The standalone engine release currently supports 64-bit Windows only.'
    }
}

function Get-ReleaseAssets([string]$RequestedVersion) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'M9R-Windows-Installer'; 'Accept' = 'application/vnd.github+json' }
    if ($RequestedVersion) {
        $tag = "$releaseTagPrefix$RequestedVersion"
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers
    } else {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers $headers
        $release = $releases | Where-Object { $_.tag_name -match '^m9r-engine-v\d+\.\d+\.\d+$' -and -not $_.draft -and -not $_.prerelease } | Select-Object -First 1
        if (-not $release) { throw 'No published M9R engine release was found. The standalone installer is not publicly available yet.' }
    }
    if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^m9r-engine-v\d+\.\d+\.\d+$') {
        throw 'The selected GitHub release is not a published, versioned M9R engine release.'
    }
    $zip = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    $sha = $release.assets | Where-Object { $_.name -eq $checksumName } | Select-Object -First 1
    if (-not $zip -or -not $sha) { throw "Release $($release.tag_name) is missing the engine ZIP or its SHA-256 sidecar." }
    return @{ Release = $release; Zip = $zip; Checksum = $sha }
}

function Get-VerifiedPackage([string]$LocalPackagePath, [string]$DownloadRoot) {
    if ($LocalPackagePath) {
        $zipPath = (Resolve-Path -LiteralPath $LocalPackagePath -ErrorAction Stop).Path
        $shaPath = "$zipPath.sha256"
    } else {
        $assets = Get-ReleaseAssets $Version
        $zipPath = Join-Path $DownloadRoot $assetName
        $shaPath = "$zipPath.sha256"
        foreach ($asset in @($assets.Zip, $assets.Checksum)) {
            if ($asset.browser_download_url -notmatch '^https://github\.com/ayaanali-ai/M9R/releases/download/m9r-engine-v\d+\.\d+\.\d+/') {
                throw 'Release asset URL is outside the expected M9R GitHub release host/path.'
            }
        }
        Invoke-WebRequest -Uri $assets.Zip.browser_download_url -OutFile $zipPath -Headers @{ 'User-Agent' = 'M9R-Windows-Installer' }
        Invoke-WebRequest -Uri $assets.Checksum.browser_download_url -OutFile $shaPath -Headers @{ 'User-Agent' = 'M9R-Windows-Installer' }
    }

    if (-not (Test-Path -LiteralPath $shaPath -PathType Leaf)) { throw "Checksum sidecar is missing: $shaPath" }
    $sidecar = (Get-Content -LiteralPath $shaPath -Raw).Trim()
    if ($sidecar -notmatch '^([a-fA-F0-9]{64})(?:\s+\*?m9r-engine-windows-x64\.zip)?$') {
        throw 'Checksum sidecar has an invalid format.'
    }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'The downloaded package SHA-256 does not match its sidecar. Nothing was installed.' }
    return @{ ZipPath = $zipPath }
}

function Expand-VerifiedPackage([string]$ZipPath, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -match '(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))') {
                throw 'The release ZIP contains an absolute or parent-traversal path.'
            }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The release ZIP contains a path outside its extraction directory.'
            }
        }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
    foreach ($name in @('m9r-engine.exe', 'm9r-hook.exe', 'INSTALLATION.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Destination $name) -PathType Leaf)) {
            throw "The release package is incomplete; '$name' is missing."
        }
    }
}

function Read-Consent([string]$Prompt) {
    return (Read-Host "$Prompt [y/N]") -match '^(?i:y|yes)$'
}

function Remove-M9rTemporaryDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $resolved = [IO.Path]::GetFullPath($Path)
    $leaf = Split-Path -Leaf $resolved
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or $leaf -notmatch '^m9r-(?:setup|uninstall)-[a-f0-9]{32}$') {
        throw "Refusing to recursively remove an unexpected temporary path: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-InstalledUninstall {
    $installed = Join-Path $env:USERPROFILE '.m9r\bin\m9r-engine.exe'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { throw "M9R engine was not found at $installed" }
    $maintenanceDir = Join-Path ([IO.Path]::GetTempPath()) ("m9r-uninstall-" + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $maintenanceDir)
    try {
        $maintenanceExe = Join-Path $maintenanceDir 'm9r-engine.exe'
        Copy-Item -LiteralPath $installed -Destination $maintenanceExe
        $manifestPath = Join-Path $env:USERPROFILE '.m9r\install-manifest.json'
        Write-Host 'M9R uninstall will:' -ForegroundColor Cyan
        if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            foreach ($entry in $manifest.entries) {
                $action = if ($entry.existedBefore) { 'restore or clean' } else { 'remove' }
                Write-Host "  - $action $($entry.path)"
            }
            foreach ($runtimeFile in $manifest.runtimeFiles) { Write-Host "  - remove $runtimeFile" }
            if ($manifest.autostart) { Write-Host '  - disable the M9R start-at-sign-in option' }
        } else {
            Write-Host '  - no managed agent configuration manifest was found; engine will make no config changes'
        }
        Write-Host '  - stop the M9R resident engine and remove only files recorded by its setup manifest'
        if (-not (Read-Consent 'Go ahead and apply this removal plan?')) {
            Write-Host 'Nothing was changed.'
            return
        }
        & $maintenanceExe uninstall --yes
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw "M9R uninstall exited with code $code." }
        if (Test-Path -LiteralPath $installed) {
            throw "Setup completed but the installed executable remains at $installed. Remove that file manually after closing M9R processes."
        }
        Write-Host 'M9R setup was removed. The installer made no unrelated cleanup or data purge.'
    } finally {
        Remove-M9rTemporaryDirectory $maintenanceDir
    }
}

$temporaryRoot = $null
try {
    Assert-M9rWindows
    if ($Uninstall) {
        Invoke-InstalledUninstall
        exit 0
    }

    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("m9r-setup-" + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $temporaryRoot)
    $package = Get-VerifiedPackage $PackagePath $temporaryRoot
    $payload = Join-Path $temporaryRoot 'payload'
    [void](New-Item -ItemType Directory -Path $payload)
    Expand-VerifiedPackage $package.ZipPath $payload

    Write-Host ''
    Write-Host 'M9R FIRST-RUN CONSENT' -ForegroundColor Cyan
    Write-Host 'The verified package contains unsigned Windows executables. SHA-256 checks integrity, not publisher identity. No administrator access is requested.'
    Write-Host 'If you continue, M9R will install its engine and small hook helper in your user profile, add managed M9R instructions/hooks to supported local agent configuration, and back up files before changing them.'
    Write-Host 'The local engine watches supported local agent session files to detect session status and explicit @agent mentions. This local setup does not upload those files or require an M9R account. Cloud connections are separate.'
    Write-Host 'Codex may show its own /hooks trust screen later; that provider-controlled trust step remains yours to accept or decline.'
    Write-Host ''
    Write-Host 'Exact setup plan from the engine:' -ForegroundColor Cyan
    $engine = Join-Path $payload 'm9r-engine.exe'
    $plan = @(& $engine setup --dry-run 2>&1)
    $planExit = $LASTEXITCODE
    if ($planExit -ne 0) { $plan | ForEach-Object { Write-Host $_ }; throw "M9R could not prepare its setup plan (exit $planExit). Nothing was installed." }
    foreach ($line in $plan) {
        $text = [string]$line
        $text = $text -replace 'm9r-cli uninstall', 'm9r-engine uninstall'
        Write-Host $text
    }
    Write-Host ''
    if (-not (Read-Consent 'Do you approve this exact local setup?')) {
        Write-Host 'Cancelled. No agent configuration was changed.'
        exit 0
    }

    & $engine setup --yes
    $setupExit = $LASTEXITCODE
    if ($setupExit -ne 0) { throw "M9R setup exited with code $setupExit. Review the engine output; do not rerun blindly." }
    Write-Host ''
    Write-Host 'M9R setup finished. Start a new supported agent session to activate its hooks.' -ForegroundColor Green
    Write-Host "To undo the managed setup later: `"$env:USERPROFILE\.m9r\bin\m9r-engine.exe`" uninstall"
    Write-Host 'Codex hook trust remains optional and is handled by Codex itself.'
    exit 0
} catch {
    Write-Host $_ -ForegroundColor Red
    exit 1
} finally {
    if ($temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
        Remove-M9rTemporaryDirectory $temporaryRoot
    }
}
