[CmdletBinding()]
param(
    # Do not evaluate script-relative defaults in the param block. PowerShell can
    # bind that block before $PSScriptRoot is populated (notably when invoked by
    # the packaged updater), which previously produced an empty source path.
    [string]$SourcePath = '',
    [string]$M9rHome = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$scriptRoot = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Join-Path $scriptRoot '..\engine\dist\m9r-web-broker.exe'
}
if ([string]::IsNullOrWhiteSpace($M9rHome)) {
    $M9rHome = if (-not [string]::IsNullOrWhiteSpace($env:M9R_HOME)) {
        $env:M9R_HOME
    } else {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.m9r'
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-ManagedBrokerManifest([string]$Path, [string]$ExpectedTarget) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "The managed web-broker ownership record is missing: $Path"
    }
    try { $record = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "The managed web-broker ownership record is unreadable: $Path" }
    $recordedPath = [IO.Path]::GetFullPath([string]$record.path)
    $targetPath = [IO.Path]::GetFullPath($ExpectedTarget)
    if ($record.version -ne 1 -or
        -not [string]::Equals($recordedPath, $targetPath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$record.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "The managed web-broker ownership record is invalid: $Path"
    }
    return $record
}

function Write-ManagedBrokerManifest([string]$Path, [string]$Target, [string]$Hash, [string]$TemporaryRoot) {
    $temporary = Join-Path $TemporaryRoot 'web-broker-install.json'
    $document = [ordered]@{ version = 1; path = [IO.Path]::GetFullPath($Target); sha256 = $Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $document) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Invoke-ManagedBrokerPhase([string]$Engine, [ValidateSet('stop', 'start')][string]$Phase) {
    $output = @(& $Engine web broker-update $Phase 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "The managed web broker could not complete '$Phase' (exit $LASTEXITCODE): $($output -join ' ')"
    }
    return $output
}

function Wait-VerifiedBroker([string]$HealthUrl, [string]$ExpectedHash) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        try {
            $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
            if ($health.ok -eq $true -and $health.broker -eq 'alive' -and
                $health.runtimeIdentity.status -eq 'verified' -and
                [string]::Equals([string]$health.runtimeIdentity.actualSha256, $ExpectedHash, [StringComparison]::OrdinalIgnoreCase)) {
                return $health
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "The managed web broker did not return verified health for $ExpectedHash."
}

$root = [IO.Path]::GetFullPath($M9rHome)
$source = [IO.Path]::GetFullPath($SourcePath)
$bin = Join-Path $root 'bin'
$target = Join-Path $bin 'm9r-web-broker.exe'
$manifestPath = Join-Path $root 'web-broker-install.json'
$engine = Join-Path $bin 'm9r-engine.exe'
$healthUrl = 'http://127.0.0.1:47821/health'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "The source web broker is missing: $source" }
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "The installed web broker is missing: $target" }
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) { throw "The installed M9R engine is missing: $engine" }

$manifest = Read-ManagedBrokerManifest $manifestPath $target
$oldHash = Get-Sha256 $target
if (-not [string]::Equals($oldHash, [string]$manifest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a web broker that differs from its ownership record."
}
$sourceHash = Get-Sha256 $source
if ([string]::Equals($sourceHash, $oldHash, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Output "The managed web broker already matches the source hash $sourceHash."
    [void](Wait-VerifiedBroker $healthUrl $sourceHash)
    exit 0
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("m9r-web-broker-update-" + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temporaryRoot)
$backup = Join-Path $temporaryRoot 'm9r-web-broker.previous.exe'
$staged = Join-Path $temporaryRoot 'm9r-web-broker.exe'
$manifestBackup = Join-Path $temporaryRoot 'web-broker-install.previous.json'
$brokerStopped = $false
$targetReplaced = $false
$manifestReplaced = $false
try {
    Copy-Item -LiteralPath $target -Destination $backup
    Copy-Item -LiteralPath $manifestPath -Destination $manifestBackup
    [void](Invoke-ManagedBrokerPhase $engine 'stop')
    $brokerStopped = $true

    Copy-Item -LiteralPath $source -Destination $staged
    if ((Get-Sha256 $staged) -ne $sourceHash) { throw 'The staged web broker failed its SHA-256 check.' }
    Move-Item -LiteralPath $staged -Destination $target -Force
    $targetReplaced = $true
    Write-ManagedBrokerManifest $manifestPath $target $sourceHash $temporaryRoot
    $manifestReplaced = $true

    [void](Invoke-ManagedBrokerPhase $engine 'start')
    $brokerStopped = $false
    [void](Wait-VerifiedBroker $healthUrl $sourceHash)
    Write-Output "Workspace-only web broker update verified: $sourceHash"
} catch {
    $failure = $_.Exception.Message
    try {
        if (-not $brokerStopped) { [void](Invoke-ManagedBrokerPhase $engine 'stop'); $brokerStopped = $true }
        if ($targetReplaced) { Copy-Item -LiteralPath $backup -Destination $target -Force }
        if ($manifestReplaced) { Copy-Item -LiteralPath $manifestBackup -Destination $manifestPath -Force }
        [void](Invoke-ManagedBrokerPhase $engine 'start')
        $brokerStopped = $false
    } catch {
        throw "Workspace-only web broker update failed and automatic rollback could not complete: $failure; rollback: $($_.Exception.Message)"
    }
    throw "Workspace-only web broker update failed and was rolled back: $failure"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
