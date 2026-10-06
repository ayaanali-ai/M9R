[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'engine\dist'
$assets = @('m9r-engine.exe', 'm9r-hook.exe', 'm9r-native-input-host.exe', 'm9r-web-broker.exe')
$overlay = Join-Path $root 'overlay\src-tauri\target\release\m9r-overlay.exe'
$extension = Join-Path $root 'cli\dist\extension'
$cuaRuntime = Join-Path $dist 'cua-driver-runtime'
$destination = [IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $dist -PathType Container)) { throw 'engine/dist is missing. Run npm run build:engine on Windows first.' }
foreach ($asset in $assets) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $asset) -PathType Leaf)) { throw "Required release binary is missing: engine/dist/$asset" }
}
if (-not (Test-Path -LiteralPath $overlay -PathType Leaf)) {
    throw 'Required release binary is missing: overlay/src-tauri/target/release/m9r-overlay.exe. Build the M9R desktop pill before packaging the standalone release.'
}
if (-not (Test-Path -LiteralPath (Join-Path $extension 'manifest.json') -PathType Leaf)) { throw 'cli/dist/extension is missing. Run npm run build:cli first.' }
foreach ($runtimeFile in @(
    (Join-Path $cuaRuntime 'node_modules\@trycua\cua-driver\dist\index.js'),
    (Join-Path $cuaRuntime 'node_modules\@trycua\cua-driver-win32-x64-msvc\cua_driver_sdk.dll'),
    (Join-Path $cuaRuntime 'node_modules\@trycua\cua-driver-win32-x64-msvc\cua_driver_node_runtime.node'),
    (Join-Path $cuaRuntime 'node_modules\@ubjs\node-win32-x64-msvc\uniffi-runtime-napi.win32-x64-msvc.node'),
    (Join-Path $cuaRuntime 'node_modules\@trycua\cua-driver-win32-x64-msvc\node-runtime-NOTICE.md'),
    (Join-Path $cuaRuntime 'bin\cua-driver.exe'),
    (Join-Path $cuaRuntime 'bin\cua-driver-uia.exe'),
    (Join-Path $cuaRuntime 'bin\cua-cursor-theme.exe'),
    (Join-Path $cuaRuntime 'bin\cua_driver_sdk.dll'),
    (Join-Path $cuaRuntime 'bin\cua_driver_node_runtime.node'),
    (Join-Path $cuaRuntime 'bin\cua_driver_abi.h'),
    (Join-Path $root 'cli\THIRD_PARTY_NOTICES.md'),
    (Join-Path $root 'cli\licenses\MIT-Cua.txt'),
    (Join-Path $root 'cli\licenses\MPL-2.0.txt'),
    (Join-Path $root 'cli\licenses\Cua-Driver-Node-Runtime-NOTICE.md')
)) {
    if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) { throw "Required Cua Driver runtime or license notice is missing: $runtimeFile. Run npm run build:engine on Windows first." }
}
if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $destination)
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("m9r-release-stage-" + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $stage)
try {
    foreach ($asset in $assets) { Copy-Item -LiteralPath (Join-Path $dist $asset) -Destination (Join-Path $stage $asset) }
    Copy-Item -LiteralPath $overlay -Destination (Join-Path $stage 'm9r-overlay.exe')
    Copy-Item -LiteralPath $cuaRuntime -Destination (Join-Path $stage 'cua-driver-runtime') -Recurse
    Copy-Item -LiteralPath $extension -Destination (Join-Path $stage 'extension') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'cli\THIRD_PARTY_NOTICES.md') -Destination (Join-Path $stage 'THIRD_PARTY_NOTICES.md')
    Copy-Item -LiteralPath (Join-Path $root 'cli\licenses') -Destination (Join-Path $stage 'licenses') -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-m9r.ps1') -Destination (Join-Path $stage 'install-m9r.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-m9r.cmd') -Destination (Join-Path $stage 'install-m9r.cmd')
    @'
M9R standalone Windows engine package

Requirements: 64-bit Windows and PowerShell 5.1 or newer. Node.js and npm are not required. M9R's verified native Windows cursor host is bundled for local agent cursors and window-targeted stage actions.

Before extracting, verify the ZIP hash against m9r-engine-windows-x64.zip.sha256:
  Get-FileHash .\m9r-engine-windows-x64.zip -Algorithm SHA256

The executables and the M9R desktop pill are currently unsigned; a matching SHA-256 checksum detects corruption but does not prove publisher identity. After verifying and extracting the archive, review install-m9r.ps1. If Windows marks it as downloaded, use the file's Properties > Unblock control, then double-click install-m9r.cmd (or run the PowerShell script normally; do not pipe downloaded code into PowerShell). To install the exact ZIP you verified, point -PackagePath at it; otherwise the script fetches the latest stable release and verifies that download itself:
  .\install-m9r.ps1 -PackagePath ..\m9r-engine-windows-x64.zip

The installer shows the engine's exact local setup plan and asks before editing agent configuration. It adds the M9R desktop pill to this Windows user's sign-in startup by default; pass -NoAutostart to opt out. The pill supervises the local engine. The installer honors M9R_HOME consistently for the engine, broker, setup, and uninstall.

To also configure M9R Web, pass -Web to the installer. It previews agent MCP changes, installs the fixed-ID extension files, and asks you to load the folder once in Chrome/Edge (the browser confirmation remains manual).

Uninstall the managed setup (review the plan before confirming):
  .\install-m9r.ps1 -Uninstall

This package does not request administrator privileges. Setup changes are recorded by the engine for reversible removal. It does not purge local M9R data.
'@ | Set-Content -LiteralPath (Join-Path $stage 'INSTALLATION.txt') -Encoding UTF8

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $destination 'm9r-engine-windows-x64.zip'
    $checksum = "$zip.sha256"
    if (Test-Path -LiteralPath $zip) { throw "Refusing to overwrite existing release asset: $zip" }
    if (Test-Path -LiteralPath $checksum) { throw "Refusing to overwrite existing checksum: $checksum" }
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  m9r-engine-windows-x64.zip" | Set-Content -LiteralPath $checksum -Encoding ASCII
    Write-Output "Created $zip"
    Write-Output "Created $checksum"
} finally {
    if (Test-Path -LiteralPath $stage) {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if (-not $resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedStage) -notmatch '^m9r-release-stage-[a-f0-9]{32}$') {
            throw "Refusing to recursively remove an unexpected staging path: $resolvedStage"
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
