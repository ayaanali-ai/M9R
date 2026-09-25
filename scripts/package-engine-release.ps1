[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'engine\dist'
$assets = @('m9r-engine.exe', 'm9r-hook.exe')
$destination = [IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $dist -PathType Container)) { throw 'engine/dist is missing. Run npm run build:engine on Windows first.' }
foreach ($asset in $assets) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $asset) -PathType Leaf)) { throw "Required release binary is missing: engine/dist/$asset" }
}
if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $destination)
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("m9r-release-stage-" + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $stage)
try {
    foreach ($asset in $assets) { Copy-Item -LiteralPath (Join-Path $dist $asset) -Destination (Join-Path $stage $asset) }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-m9r.ps1') -Destination (Join-Path $stage 'install-m9r.ps1')
    @'
M9R standalone Windows engine package

Requirements: 64-bit Windows and PowerShell 5.1 or newer. Node.js and npm are not required.

Before extracting, verify the ZIP hash against m9r-engine-windows-x64.zip.sha256:
  Get-FileHash .\m9r-engine-windows-x64.zip -Algorithm SHA256

The executables are currently unsigned; a matching SHA-256 checksum detects corruption but does not prove publisher identity. After verifying and extracting the archive, review install-m9r.ps1. If Windows marks it as downloaded, use the file's Properties > Unblock control, then run it normally (do not pipe downloaded code into PowerShell). To install the exact ZIP you verified, point -PackagePath at it; otherwise the script fetches the latest stable release and verifies that download itself:
  .\install-m9r.ps1 -PackagePath ..\m9r-engine-windows-x64.zip

The installer shows the engine's exact local setup plan and asks before editing agent configuration.

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
