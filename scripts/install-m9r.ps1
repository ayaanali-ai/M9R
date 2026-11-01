<#
.SYNOPSIS
Installs the self-contained M9R Windows engine and runs its consent-driven setup.

.DESCRIPTION
No Node.js, npm, or administrator rights are required. The CMD launcher uses
a process-only execution-policy bypass; it does not change any saved policy.
The script downloads only a versioned GitHub release asset, verifies its SHA-256
sidecar and owner-accepted runtime identity, previews the exact setup plan, then
asks once before writing.

.PARAMETER Version
An exact release version such as 0.1.0. Defaults to the latest m9r-engine-v* release.

.PARAMETER PackagePath
Use a previously downloaded release ZIP. Its adjacent .sha256 file is required.

.PARAMETER AllowLocalCandidate
Explicitly install a locally built candidate after its external candidate.json receipt
matches the exact ZIP and runtime artifacts. It must also match the current owner-accepted
runtime policy; a historical receipt never promotes a runtime.

.PARAMETER CandidateReceiptPath
Path to the candidate.json stored outside the candidate ZIP. Required with -AllowLocalCandidate.

.PARAMETER Uninstall
Run the installed engine's reversible uninstall. It runs from a temporary copy
because Windows does not allow a process to delete its own executable.

.PARAMETER Web
Retired. The desktop broker owns provider processes directly; the legacy browser-extension/provider-hook transport is not installed.

.PARAMETER NoAutostart
Do not add the M9R desktop pill to this Windows user's sign-in startup list.

.PARAMETER NoLaunch
Install without starting the desktop pill after setup. Intended for automated tests.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$PackagePath,
    [switch]$AllowLocalCandidate,
    [string]$CandidateReceiptPath,
    [switch]$Uninstall,
    [switch]$Web,
    [switch]$NoAutostart,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'ayaanali-ai/M9R'
$assetName = 'm9r-engine-windows-x64.zip'
$checksumName = "$assetName.sha256"
$policyName = 'm9r-accepted-runtime.json'
$releaseTagPrefix = 'm9r-engine-v'
$script:TrustedRuntimePolicyPath = $null
$script:CandidateReceipt = $null
$script:VerifiedCandidateReceiptPath = $null
$script:PackageSha256 = $null
$script:VerifiedZipPath = $null

if ($Web) {
    throw 'The legacy browser-extension/provider-hook transport is retired. Omit -Web; M9R now uses the broker-owned desktop runtime.'
}

function Assert-M9rWindows {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'The standalone installer currently supports Windows only.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'The standalone engine release currently supports 64-bit Windows only.'
    }
}

function Get-M9rHome {
    $configured = $env:M9R_HOME
    if ([string]::IsNullOrWhiteSpace($configured)) {
        $configured = Join-Path $env:USERPROFILE '.m9r'
    } else {
        $configured = $configured.Trim()
    }
    return [IO.Path]::GetFullPath($configured)
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
    $policy = $release.assets | Where-Object { $_.name -eq $policyName } | Select-Object -First 1
    if (-not $zip -or -not $sha -or -not $policy) { throw "Release $($release.tag_name) is missing the engine ZIP, checksum, or separate runtime policy." }
    return @{ Release = $release; Zip = $zip; Checksum = $sha; Policy = $policy }
}

function Get-VerifiedPackage([string]$LocalPackagePath, [string]$DownloadRoot) {
    if ($AllowLocalCandidate -and (-not $LocalPackagePath -or [string]::IsNullOrWhiteSpace($CandidateReceiptPath))) {
        throw 'A local candidate install requires both -PackagePath and an external -CandidateReceiptPath.'
    }
    if ($AllowLocalCandidate -and $Version) {
        throw 'Do not combine -AllowLocalCandidate with -Version; a local candidate is verified by its external receipt.'
    }
    if ($LocalPackagePath) {
        $zipPath = (Resolve-Path -LiteralPath $LocalPackagePath -ErrorAction Stop).Path
        $shaPath = "$zipPath.sha256"
        if ($AllowLocalCandidate) {
            $receiptPath = (Resolve-Path -LiteralPath $CandidateReceiptPath -ErrorAction Stop).Path
            try { $script:CandidateReceipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json }
            catch { throw 'The external candidate receipt is invalid JSON. Nothing was installed.' }
            $script:VerifiedCandidateReceiptPath = $receiptPath
        } else {
            $repoRoot = Split-Path -Parent $PSScriptRoot
            $localPolicy = Join-Path $repoRoot 'release-assets\accepted-runtime.json'
            if ($Version -or -not (Test-Path -LiteralPath $localPolicy -PathType Leaf)) {
                $assets = Get-ReleaseAssets $Version
                $policyPath = Join-Path $DownloadRoot $policyName
                if ($assets.Policy.browser_download_url -notmatch '^https://github\.com/ayaanali-ai/M9R/releases/download/m9r-engine-v\d+\.\d+\.\d+/') {
                    throw 'Release runtime policy URL is outside the expected M9R GitHub release host/path.'
                }
                Invoke-WebRequest -Uri $assets.Policy.browser_download_url -OutFile $policyPath -Headers @{ 'User-Agent' = 'M9R-Windows-Installer' }
                $script:TrustedRuntimePolicyPath = $policyPath
            } else {
                $script:TrustedRuntimePolicyPath = $localPolicy
            }
        }
    } else {
        if ($AllowLocalCandidate) { throw '-AllowLocalCandidate only accepts an explicit local package path.' }
        $assets = Get-ReleaseAssets $Version
        $zipPath = Join-Path $DownloadRoot $assetName
        $shaPath = "$zipPath.sha256"
        $policyPath = Join-Path $DownloadRoot $policyName
        foreach ($asset in @($assets.Zip, $assets.Checksum, $assets.Policy)) {
            if ($asset.browser_download_url -notmatch '^https://github\.com/ayaanali-ai/M9R/releases/download/m9r-engine-v\d+\.\d+\.\d+/') {
                throw 'Release asset URL is outside the expected M9R GitHub release host/path.'
            }
        }
        Invoke-WebRequest -Uri $assets.Zip.browser_download_url -OutFile $zipPath -Headers @{ 'User-Agent' = 'M9R-Windows-Installer' }
        Invoke-WebRequest -Uri $assets.Checksum.browser_download_url -OutFile $shaPath -Headers @{ 'User-Agent' = 'M9R-Windows-Installer' }
        Invoke-WebRequest -Uri $assets.Policy.browser_download_url -OutFile $policyPath -Headers @{ 'User-Agent' = 'M9R-Windows-Installer' }
        $script:TrustedRuntimePolicyPath = $policyPath
    }

    if (-not (Test-Path -LiteralPath $shaPath -PathType Leaf)) { throw "Checksum sidecar is missing: $shaPath" }
    $sidecar = (Get-Content -LiteralPath $shaPath -Raw).Trim()
    if ($sidecar -notmatch '^([a-fA-F0-9]{64})(?:\s+\*?m9r-engine-windows-x64\.zip)?$') {
        throw 'Checksum sidecar has an invalid format.'
    }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'The downloaded package SHA-256 does not match its sidecar. Nothing was installed.' }
    $script:PackageSha256 = $actual
    $script:VerifiedZipPath = [IO.Path]::GetFullPath($zipPath)
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
    foreach ($name in @('m9r-engine.exe', 'm9r-native-input-host.exe', 'm9r-web-broker.exe', 'm9r-overlay.exe', 'm9r-build-info.json', 'INSTALLATION.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Destination $name) -PathType Leaf)) {
            throw "The release package is incomplete; '$name' is missing."
        }
    }
}

function Get-AcceptedRuntimeIdentity {
    # Never trust the policy copied beside an installer inside the ZIP: an old
    # package could otherwise approve its own old runtime. Use the checkout's
    # owner-controlled policy or the separate policy asset fetched from GitHub.
    $path = $script:TrustedRuntimePolicyPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        $repoRoot = Split-Path -Parent $PSScriptRoot
        $path = Join-Path $repoRoot 'release-assets\accepted-runtime.json'
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'The installer has no owner-accepted runtime identity. Use the current M9R installer package; no files were installed.'
    }
    try { $identity = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { throw "The owner-accepted runtime identity is invalid JSON: $path" }
    if ($identity.schemaVersion -ne 1 -or [string]$identity.buildId -notmatch '^[a-fA-F0-9]{64}$' -or -not $identity.artifacts) {
        throw "The owner-accepted runtime identity is malformed: $path"
    }
    return $identity
}

function Assert-LocalCandidateReceipt($Runtime, [string]$PayloadRoot) {
    if (-not $AllowLocalCandidate) { return }
    $receipt = $script:CandidateReceipt
    if (-not $receipt -or $receipt.schemaVersion -ne 1 -or $receipt.buildMode -ne 'accepted-live-overlay' -or
        [string]$receipt.candidateId -notmatch '^\d{4}-\d{2}-\d{2}T.+-[a-fA-F0-9]{8}$') {
        throw 'The external candidate receipt is malformed. Nothing was installed.'
    }
    $receiptRoot = Split-Path -Parent $script:VerifiedCandidateReceiptPath
    if (-not [string]::Equals((Split-Path -Leaf $receiptRoot), [string]$receipt.candidateId, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The candidate receipt ID does not match its directory. Nothing was installed.'
    }
    $relativePackagePath = [string]$receipt.package.path
    if ($relativePackagePath -match '(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))') {
        throw 'The candidate receipt contains an unsafe package path. Nothing was installed.'
    }
    $expectedPackagePath = [IO.Path]::GetFullPath((Join-Path $receiptRoot $relativePackagePath.Replace('/', [IO.Path]::DirectorySeparatorChar)))
    if (-not [string]::Equals($expectedPackagePath, $script:VerifiedZipPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The external candidate receipt points to a different package. Nothing was installed.'
    }
    if (-not [string]::Equals([string]$receipt.package.sha256, [string]$script:PackageSha256, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$receipt.runtimeBuildId, [string]$Runtime.buildId, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$receipt.sourceCommit, [string]$Runtime.source.sourceCommit, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$receipt.pillSha256, [string]$Runtime.artifacts.'m9r-overlay.exe', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The external candidate receipt does not match the exact ZIP, source, runtime, or pill. Nothing was installed.'
    }
    foreach ($field in @('runtimeManifest', 'exactRuntimeArtifactSet', 'acceptedPillHash', 'packageChecksum')) {
        if ($receipt.verified.$field -ne $true) { throw "The candidate receipt does not verify $field. Nothing was installed." }
    }
}

function Assert-AcceptedRuntimePackage([string]$PayloadRoot) {
    $runtimePath = Join-Path $PayloadRoot 'm9r-build-info.json'
    try { $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json }
    catch { throw 'The package runtime identity is invalid JSON. Nothing was installed.' }
    if ($AllowLocalCandidate) {
        Assert-LocalCandidateReceipt $runtime $PayloadRoot
    }
    # A historical receipt is provenance only, never promotion authority.
    $accepted = Get-AcceptedRuntimeIdentity
    if ($AllowLocalCandidate) {
        # An explicitly supplied local candidate is the controlled promotion
        # path for development/demo builds. Its external receipt binds the
        # exact ZIP, source commit, runtime manifest, and artifact hashes. The
        # owner-accepted policy still pins the visual pill so a runtime update
        # can never silently replace the accepted UI, but engine/broker/helper
        # binaries are allowed to advance as one verified candidate set.
        $acceptedPill = [string]$accepted.artifacts.'m9r-overlay.exe'
        $candidatePill = [string]$runtime.artifacts.'m9r-overlay.exe'
        if (($acceptedPill -notmatch '^[a-fA-F0-9]{64}$' -or $candidatePill -notmatch '^[a-fA-F0-9]{64}$') -or
            (-not [string]::Equals($candidatePill, $acceptedPill, [StringComparison]::OrdinalIgnoreCase))) {
            throw 'The local candidate pill does not match the owner-accepted live pill. Nothing was installed.'
        }
        $runtimeEntries = @($runtime.artifacts.PSObject.Properties)
        if ($runtimeEntries.Count -eq 0) { throw 'The local candidate runtime has no artifact inventory. Nothing was installed.' }
        $runtimeRoot = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $runtimeEntries) {
            $relative = [string]$entry.Name
            if ($relative -match '(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))') {
                throw "The local candidate runtime contains an unsafe artifact path: $relative"
            }
            $artifact = [IO.Path]::GetFullPath((Join-Path $PayloadRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
            if (-not $artifact.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
                throw "The local candidate is missing runtime artifact $relative. Nothing was installed."
            }
            $actual = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
            if (-not [string]::Equals($actual, [string]$entry.Value, [StringComparison]::OrdinalIgnoreCase)) {
                throw "The local candidate runtime hash differs at $relative. Nothing was installed."
            }
        }
        $embeddedPolicyPath = Join-Path $PayloadRoot 'm9r-accepted-runtime.json'
        if (Test-Path -LiteralPath $embeddedPolicyPath -PathType Leaf) {
            try { $embeddedPolicy = Get-Content -LiteralPath $embeddedPolicyPath -Raw | ConvertFrom-Json }
            catch { throw 'The local candidate installer policy is invalid JSON. Nothing was installed.' }
            if ((-not [string]::Equals([string]$embeddedPolicy.buildId, [string]$runtime.buildId, [StringComparison]::OrdinalIgnoreCase)) -or
                (-not [string]::Equals([string]$embeddedPolicy.artifacts.'m9r-overlay.exe', $candidatePill, [StringComparison]::OrdinalIgnoreCase))) {
                throw 'The local candidate installer policy does not match its runtime manifest. Nothing was installed.'
            }
        }
        return
    }
    if ($runtime.schemaVersion -ne 1 -or -not [string]::Equals([string]$runtime.buildId, [string]$accepted.buildId, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The package build ID is not the owner-accepted runtime ($($accepted.buildId)). Nothing was installed."
    }
    $expectedEntries = @($accepted.artifacts.PSObject.Properties)
    $runtimeEntries = @($runtime.artifacts.PSObject.Properties)
    if ($runtimeEntries.Count -ne $expectedEntries.Count) {
        throw 'The package artifact inventory differs from the owner-accepted runtime. Nothing was installed.'
    }
    foreach ($entry in $expectedEntries) {
        $matching = @($runtimeEntries | Where-Object { $_.Name -ceq $entry.Name })
        if ($matching.Count -ne 1 -or -not [string]::Equals([string]$matching[0].Value, [string]$entry.Value, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The package runtime identity differs from the accepted runtime at $($entry.Name). Nothing was installed."
        }
        $relative = [string]$entry.Name
        if ($relative -match '(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))') {
            throw "The accepted runtime identity contains an unsafe artifact path: $relative"
        }
        $root = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $artifact = [IO.Path]::GetFullPath((Join-Path $PayloadRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
        if (-not $artifact.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            throw "The package is missing accepted runtime artifact $relative. Nothing was installed."
        }
        $actual = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
        if (-not [string]::Equals($actual, [string]$entry.Value, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The package artifact hash differs from the accepted runtime at $relative. Nothing was installed."
        }
    }

    $embeddedPolicyPath = Join-Path $PayloadRoot 'm9r-accepted-runtime.json'
    if (Test-Path -LiteralPath $embeddedPolicyPath -PathType Leaf) {
        try { $embeddedPolicy = Get-Content -LiteralPath $embeddedPolicyPath -Raw | ConvertFrom-Json }
        catch { throw 'The package accepted-runtime policy is invalid JSON. Nothing was installed.' }
        if (-not [string]::Equals([string]$embeddedPolicy.buildId, [string]$accepted.buildId, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The package installer policy differs from the current owner-accepted runtime. Nothing was installed.'
        }
        $embeddedEntries = @($embeddedPolicy.artifacts.PSObject.Properties)
        if ($embeddedEntries.Count -ne $expectedEntries.Count) { throw 'The package installer policy has a different artifact inventory. Nothing was installed.' }
        foreach ($entry in $expectedEntries) {
            $matching = @($embeddedEntries | Where-Object { $_.Name -ceq $entry.Name })
            if ($matching.Count -ne 1 -or -not [string]::Equals([string]$matching[0].Value, [string]$entry.Value, [StringComparison]::OrdinalIgnoreCase)) {
                throw "The package installer policy differs from the accepted runtime at $($entry.Name). Nothing was installed."
            }
        }
    }
}

function Get-ManagedWebBrokerPaths {
    $m9rRoot = Get-M9rHome
    $bin = Join-Path $m9rRoot 'bin'
    return @{
        M9rRoot = $m9rRoot
        Bin = $bin
        Target = Join-Path $bin 'm9r-web-broker.exe'
        Manifest = Join-Path $m9rRoot 'web-broker-install.json'
    }
}

function Read-ManagedWebBrokerManifest($Paths) {
    if (-not (Test-Path -LiteralPath $Paths.Manifest -PathType Leaf)) { return $null }
    try { $manifest = Get-Content -LiteralPath $Paths.Manifest -Raw | ConvertFrom-Json }
    catch { throw "The M9R web-broker ownership record is unreadable at $($Paths.Manifest); review it before continuing." }
    $expectedPath = [IO.Path]::GetFullPath($Paths.Target)
    try { $recordedPath = [IO.Path]::GetFullPath([string]$manifest.path) }
    catch { throw "The M9R web-broker ownership record has an invalid path at $($Paths.Manifest)." }
    if ($manifest.version -ne 1 -or -not [string]::Equals($recordedPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or [string]$manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "The M9R web-broker ownership record is invalid at $($Paths.Manifest); review it before continuing."
    }
    return $manifest
}

function Test-EngineRuntimeOwnsWebBroker($Paths) {
    $engineManifestPath = Join-Path $Paths.M9rRoot 'install-manifest.json'
    if (-not (Test-Path -LiteralPath $engineManifestPath -PathType Leaf)) { return $false }
    try { $engineManifest = Get-Content -LiteralPath $engineManifestPath -Raw | ConvertFrom-Json }
    catch { throw "The M9R runtime ownership record is unreadable at $engineManifestPath; review it before continuing." }
    if ($engineManifest.version -ne 1 -or $null -eq $engineManifest.runtimeFiles) { return $false }
    $expectedPath = [IO.Path]::GetFullPath($Paths.Target)
    foreach ($recordedPath in @($engineManifest.runtimeFiles)) {
        try { $resolvedPath = [IO.Path]::GetFullPath([string]$recordedPath) }
        catch { continue }
        if ([string]::Equals($resolvedPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Assert-ManagedWebBrokerInstallable([string]$SourcePath) {
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) { throw "The standalone web broker is missing from the verified package: $SourcePath" }
    $paths = Get-ManagedWebBrokerPaths
    $manifest = Read-ManagedWebBrokerManifest $paths
    $sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $paths.Target -PathType Leaf) {
        if (-not $manifest) {
            # The engine copies all bundled companions during its atomic runtime install. The standalone
            # installer owns the broker's separate manifest, so claim an identical companion instead of
            # treating our own freshly copied file as an unrelated user binary.
            $currentHash = (Get-FileHash -LiteralPath $paths.Target -Algorithm SHA256).Hash
            $engineOwnsBroker = Test-EngineRuntimeOwnsWebBroker $paths
            if (-not [string]::Equals($currentHash, $sourceHash, [StringComparison]::OrdinalIgnoreCase) -and -not $engineOwnsBroker) {
                throw "Refusing to overwrite an unowned file at $($paths.Target)."
            }
            if ($engineOwnsBroker -and -not [string]::Equals($currentHash, $sourceHash, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Host 'The broker hash differs from this package, but its exact path is recorded by the M9R runtime manifest; the verified installer will refresh it after consent.' -ForegroundColor Yellow
            }
            return
        }
        $currentHash = (Get-FileHash -LiteralPath $paths.Target -Algorithm SHA256).Hash
        $matchesRecorded = [string]::Equals($currentHash, [string]$manifest.sha256, [StringComparison]::OrdinalIgnoreCase)
        $matchesVerifiedPackage = [string]::Equals($currentHash, $sourceHash, [StringComparison]::OrdinalIgnoreCase)
        $engineOwnsBroker = Test-EngineRuntimeOwnsWebBroker $paths
        if (-not $matchesRecorded -and -not $matchesVerifiedPackage -and -not $engineOwnsBroker) {
            throw "The installed web broker matches neither its M9R ownership record nor the verified package at $($paths.Target); it was not overwritten."
        }
        if ($engineOwnsBroker -and -not $matchesRecorded -and -not $matchesVerifiedPackage) {
            Write-Host 'The broker hash differs from its standalone ownership record, but its exact path is recorded by the M9R runtime manifest; the verified installer will refresh it after consent.' -ForegroundColor Yellow
        }
    }
}

function Write-ManagedWebBrokerManifest($Paths, [string]$Hash) {
    $temporary = Join-Path $Paths.M9rRoot ("web-broker-install-" + [guid]::NewGuid().ToString('N') + '.tmp')
    $document = [ordered]@{ version = 1; path = [IO.Path]::GetFullPath($Paths.Target); sha256 = $Hash.ToLowerInvariant() }
    try {
        $json = ConvertTo-Json -InputObject $document
        [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Paths.Manifest -Force
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Install-ManagedWebBroker([string]$SourcePath) {
    Assert-ManagedWebBrokerInstallable $SourcePath
    $paths = Get-ManagedWebBrokerPaths
    if (-not (Test-Path -LiteralPath $paths.Bin -PathType Container)) { throw "The engine setup did not create its install directory: $($paths.Bin)" }
    $sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Test-Path -LiteralPath $paths.Target -PathType Leaf) -and
        [string]::Equals((Get-FileHash -LiteralPath $paths.Target -Algorithm SHA256).Hash, $sourceHash, [StringComparison]::OrdinalIgnoreCase)) {
        $existing = Read-ManagedWebBrokerManifest $paths
        if (-not $existing -or -not [string]::Equals([string]$existing.sha256, $sourceHash, [StringComparison]::OrdinalIgnoreCase)) {
            # The engine installs bundled companions before this installer refreshes its separate broker ownership record.
            Write-ManagedWebBrokerManifest $paths $sourceHash
        }
        return
    }

    $temporary = Join-Path $paths.Bin ("m9r-web-broker-" + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Copy-Item -LiteralPath $SourcePath -Destination $temporary
        $stagedHash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($stagedHash -ne $sourceHash) { throw 'The staged standalone web broker failed its SHA-256 check.' }
        Move-Item -LiteralPath $temporary -Destination $paths.Target -Force
        Write-ManagedWebBrokerManifest $paths $sourceHash
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Remove-ManagedWebBroker {
    $paths = Get-ManagedWebBrokerPaths
    $manifest = Read-ManagedWebBrokerManifest $paths
    if (-not $manifest) { return $true }
    if (Test-Path -LiteralPath $paths.Target -PathType Leaf) {
        $currentHash = (Get-FileHash -LiteralPath $paths.Target -Algorithm SHA256).Hash
        if (-not [string]::Equals($currentHash, [string]$manifest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            Write-Warning "Keeping the web broker because it changed outside M9R setup: $($paths.Target). Its ownership record was retained."
            return $false
        }
        try { Remove-Item -LiteralPath $paths.Target -Force }
        catch {
            Write-Warning "Could not remove the managed web broker at $($paths.Target); its ownership record was retained. Close M9R Web and retry."
            return $false
        }
    }
    Remove-Item -LiteralPath $paths.Manifest -Force
    return $true
}

function Read-Consent([string]$Prompt) {
    # Read-Host only reads an interactive console. Release tests and scripted
    # maintenance use redirected stdin, so consume one line directly there
    # instead of hanging after printing the consent plan.
    if ([Console]::IsInputRedirected) {
        $answer = [Console]::In.ReadLine()
        return ([string]$answer) -match '^(?i:y|yes)$'
    }
    return (Read-Host "$Prompt [y/N]") -match '^(?i:y|yes)$'
}

function Stop-InstalledM9rPill {
    $overlay = Join-Path (Get-M9rHome) 'bin\m9r-overlay.exe'
    if (-not (Test-Path -LiteralPath $overlay -PathType Leaf)) { return }
    $expectedPath = [IO.Path]::GetFullPath($overlay)
    $matchesInstalledPill = {
        param($Process)
        try {
            return [string]::Equals([IO.Path]::GetFullPath($Process.Path), $expectedPath, [StringComparison]::OrdinalIgnoreCase)
        } catch {
            return $false
        }
    }
    $running = @(Get-Process -Name 'm9r-overlay' -ErrorAction SilentlyContinue | Where-Object { & $matchesInstalledPill $_ })
    foreach ($process in $running) {
        try {
            # The pill handles this through its existing single-instance channel, so shutdown
            # runs on the UI thread and also stops the engine child it owns. Keep WM_CLOSE as a
            # compatibility fallback for versions installed before this private argument existed.
            $request = Start-Process -FilePath $overlay -ArgumentList '--m9r-update-shutdown' -WorkingDirectory (Split-Path -Parent $overlay) -WindowStyle Hidden -PassThru
            if (-not $request.WaitForExit(5000)) {
                throw "The M9R pill's update-shutdown request (PID $($request.Id)) did not return."
            }
        } catch {
            throw "Could not close the installed M9R pill (PID $($process.Id)) before updating it. $($_.Exception.Message) No installed files were replaced."
        }
    }
    foreach ($process in $running) {
        if (-not $process.WaitForExit(15000)) {
            try { [void]$process.CloseMainWindow() } catch { }
            if (-not $process.WaitForExit(2000)) {
                throw "The installed M9R pill (PID $($process.Id)) did not exit after its managed shutdown request. No installed files were replaced."
            }
        }
    }
    $stillRunning = @(Get-Process -Name 'm9r-overlay' -ErrorAction SilentlyContinue | Where-Object { & $matchesInstalledPill $_ })
    if ($stillRunning.Count -gt 0) {
        throw 'The installed M9R pill is still running. No installed files were replaced.'
    }
}

function Invoke-ManagedBrokerUpdate([string]$EnginePath, [ValidateSet('stop', 'start')][string]$Phase) {
    if (-not (Test-Path -LiteralPath $EnginePath -PathType Leaf)) {
        throw "The M9R engine required to manage the broker update is missing: $EnginePath"
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # The native engine writes informational migration/lifecycle notices to
        # stderr. They are data, not PowerShell failures; capture them without
        # allowing the wrapper's Stop preference to abort the transaction.
        $ErrorActionPreference = 'Continue'
        $output = @(& $EnginePath web broker-update $Phase 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $output) { Write-Host ([string]$line) }
    if ($code -ne 0) { throw "M9R could not safely $Phase the managed Web broker (exit $code). No further installer files were replaced." }
    $resultLine = @($output | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\{.*"phase"\s*:\s*"' + [regex]::Escape($Phase) + '".*\}$' } | Select-Object -Last 1)
    if ($resultLine.Count -ne 1) { throw "M9R broker $Phase completed without a verifiable lifecycle receipt." }
    try { $result = $resultLine[0] | ConvertFrom-Json }
    catch { throw "M9R broker $Phase returned an invalid lifecycle receipt." }
    if ($result.ok -ne $true -or $result.phase -ne $Phase -or $result.managedTask -isnot [bool]) {
        throw "M9R broker $Phase returned an incomplete lifecycle receipt."
    }
    return $result
}

function Suspend-ManagedBrokerAutoStart {
    # Contract tests use an isolated M9R_HOME with no resident broker/task. Do
    # not query the host scheduler in that mode; production installs still
    # take the guarded task-disable path below.
    if ($env:M9R_NO_DAEMON -eq '1') { return $null }
    # Stopping the broker process alone is not enough on Windows: the logon task
    # can respawn it between the engine's stop receipt and the first atomic file
    # replacement. Disable only M9R's own task for the copy window, and return
    # the prior state so a failed install restores it exactly.
    $task = Get-ScheduledTask -TaskName 'M9R Web Broker' -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    $wasEnabled = $task.State -ne 'Disabled'
    if ($wasEnabled) {
        Disable-ScheduledTask -TaskName 'M9R Web Broker' -ErrorAction Stop | Out-Null
        $after = Get-ScheduledTask -TaskName 'M9R Web Broker' -ErrorAction Stop
        if ($after.State -ne 'Disabled') { throw 'M9R Web Broker could not be disabled for the protected runtime copy.' }
    }
    return [pscustomobject]@{ WasEnabled = $wasEnabled; Restored = $false }
}

function Restore-ManagedBrokerAutoStart($State) {
    if ($null -eq $State -or $State.Restored) { return }
    if ($State.WasEnabled) {
        Enable-ScheduledTask -TaskName 'M9R Web Broker' -ErrorAction Stop | Out-Null
        $after = Get-ScheduledTask -TaskName 'M9R Web Broker' -ErrorAction Stop
        if ($after.State -eq 'Disabled') { throw 'M9R Web Broker remained disabled after the protected runtime copy.' }
    }
    $State.Restored = $true
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
    $m9rRoot = Get-M9rHome
    $installed = Join-Path $m9rRoot 'bin\m9r-engine.exe'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
        [void](Remove-ManagedWebBroker)
        throw "M9R engine was not found at $installed"
    }
    $maintenanceDir = Join-Path ([IO.Path]::GetTempPath()) ("m9r-uninstall-" + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $maintenanceDir)
    try {
        $maintenanceExe = Join-Path $maintenanceDir 'm9r-engine.exe'
        Copy-Item -LiteralPath $installed -Destination $maintenanceExe
        $manifestPath = Join-Path $m9rRoot 'install-manifest.json'
        Write-Host 'M9R uninstall will:' -ForegroundColor Cyan
        $webBrokerManifest = Join-Path $m9rRoot 'web-broker-install.json'
        if (Test-Path -LiteralPath $webBrokerManifest -PathType Leaf) {
            $webBrokerPaths = Get-ManagedWebBrokerPaths
            [void](Read-ManagedWebBrokerManifest $webBrokerPaths)
            Write-Host "  - remove $($webBrokerPaths.Target) only if its SHA-256 still matches the installer record"
        }
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
        $webManifest = Join-Path $m9rRoot 'web-setup-manifest.json'
        if (Test-Path -LiteralPath $webManifest -PathType Leaf) {
            & $maintenanceExe web uninstall --yes
            $webExit = $LASTEXITCODE
            if ($webExit -ne 0) { throw "M9R Web uninstall exited with code $webExit. Native setup was not removed." }
        }
        & $maintenanceExe uninstall --yes
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw "M9R uninstall exited with code $code." }
        if (Test-Path -LiteralPath $installed) {
            throw "Setup completed but the installed executable remains at $installed. Remove that file manually after closing M9R processes."
        }
        [void](Remove-ManagedWebBroker)
        Write-Host 'M9R setup was removed. The installer made no unrelated cleanup or data purge.'
    } finally {
        Remove-M9rTemporaryDirectory $maintenanceDir
    }
}

$temporaryRoot = $null
$brokerNeedsResume = $false
$brokerResumeEngine = $null
$brokerTaskState = $null
try {
    Assert-M9rWindows
    # Keep the standalone engine and this PowerShell wrapper on one store root,
    # including when the caller already has a custom M9R_HOME configured.
    $env:M9R_HOME = Get-M9rHome
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
    Assert-AcceptedRuntimePackage $payload
    $packageBroker = Join-Path $payload 'm9r-web-broker.exe'
    Assert-ManagedWebBrokerInstallable $packageBroker

    Write-Host ''
    Write-Host 'M9R FIRST-RUN CONSENT' -ForegroundColor Cyan
    Write-Host 'The verified package contains unsigned Windows executables. SHA-256 checks integrity, not publisher identity. No administrator access is requested.'
    Write-Host 'If you continue, M9R will install its engine, desktop pill, browser native-input helper, and standalone Web broker in your user profile. M9R owns provider processes through the broker; no provider hooks or provider-session integrations are installed.'
    if ($NoAutostart) {
        Write-Host "M9R will not be added to this Windows user's sign-in startup list."
    } else {
        Write-Host 'M9R will start the desktop pill when this Windows user signs in. Pass -NoAutostart to skip this.'
    }
    Write-Host 'The broker starts and supervises the configured provider processes directly. Provider applications are not used as M9R lifecycle hooks, and no provider session is resumed or connected.'
    Write-Host ''
    Write-Host 'Exact setup plan from the engine:' -ForegroundColor Cyan
    $engine = Join-Path $payload 'm9r-engine.exe'
    # The plan is captured rather than run on the user's console, so the child
    # engine has no interactive terminal.  Explicit consent is still collected
    # below by this installer; --yes here only makes the preview deterministic
    # and guarantees that setup --dry-run never mutates anything.
    $dryRunArgs = @('setup', '--dry-run', '--yes')
    $applyArgs = @('setup', '--yes')
    if (-not $NoAutostart) {
        $dryRunArgs += '--autostart'
        $applyArgs += '--autostart'
    }
    $previousIncludeManagedBroker = $env:M9R_INCLUDE_MANAGED_BROKER
    try {
        # The standalone installer owns both the engine's runtime manifest and
        # the broker's separate ownership record. Include the broker in the same
        # verified file transaction; the second manifest is refreshed afterward.
        $env:M9R_INCLUDE_MANAGED_BROKER = '1'
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # The native engine writes informational migration notices to stderr.
            # They are part of the human-readable plan, not wrapper failures.
            $ErrorActionPreference = 'Continue'
            $plan = @(& $engine @dryRunArgs 2>&1)
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
    } finally {
        if ($null -eq $previousIncludeManagedBroker) { Remove-Item Env:M9R_INCLUDE_MANAGED_BROKER -ErrorAction SilentlyContinue }
        else { $env:M9R_INCLUDE_MANAGED_BROKER = $previousIncludeManagedBroker }
    }
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

    # Quiesce an owned broker before the engine setup replaces its companion files.
    # The packaged engine validates the current-user task and authenticated shutdown;
    # no process is killed by name and unrelated local services are left alone.
    $brokerResumeEngine = $engine
    $brokerStop = Invoke-ManagedBrokerUpdate $engine 'stop'
    $brokerNeedsResume = $brokerStop.managedTask
    $brokerTaskState = Suspend-ManagedBrokerAutoStart
    Stop-InstalledM9rPill
    # Native setup registers the owned broker task; this installer starts it
    # only after the new broker image and its ownership record are installed.
    $previousBrokerDefer = $env:M9R_DEFER_BROKER_START
    $previousIncludeManagedBroker = $env:M9R_INCLUDE_MANAGED_BROKER
    try {
        $env:M9R_DEFER_BROKER_START = '1'
        $env:M9R_INCLUDE_MANAGED_BROKER = '1'
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $engine @applyArgs
            $setupExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
    } finally {
        if ($null -eq $previousBrokerDefer) { Remove-Item Env:M9R_DEFER_BROKER_START -ErrorAction SilentlyContinue }
        else { $env:M9R_DEFER_BROKER_START = $previousBrokerDefer }
        if ($null -eq $previousIncludeManagedBroker) { Remove-Item Env:M9R_INCLUDE_MANAGED_BROKER -ErrorAction SilentlyContinue }
        else { $env:M9R_INCLUDE_MANAGED_BROKER = $previousIncludeManagedBroker }
    }
    if ($setupExit -ne 0) { throw "M9R setup exited with code $setupExit. Review the engine output; do not rerun blindly." }
    $installedEngine = Join-Path $env:M9R_HOME 'bin\m9r-engine.exe'
    $brokerResumeEngine = $installedEngine
    Install-ManagedWebBroker $packageBroker
    Restore-ManagedBrokerAutoStart $brokerTaskState
    Write-Host ''
    Write-Host 'M9R setup finished. The broker-owned provider processes are ready.' -ForegroundColor Green
    Write-Host "To undo the managed setup later: `"$installedEngine`" uninstall"
    $brokerStart = Invoke-ManagedBrokerUpdate $installedEngine 'start'
    $brokerNeedsResume = $false
    if ($brokerStart.managedTask) { Write-Host 'Verified the M9R Web broker is running from the installed package.' -ForegroundColor Green }
    if (-not $NoLaunch) {
        $installedOverlay = Join-Path $env:M9R_HOME 'bin\m9r-overlay.exe'
        if (-not (Test-Path -LiteralPath $installedOverlay -PathType Leaf)) { throw "M9R setup finished but the desktop pill is missing at $installedOverlay." }
        Start-Process -FilePath $installedOverlay -WorkingDirectory (Split-Path -Parent $installedOverlay)
        Write-Host 'Started the M9R desktop pill. It will also start automatically when this Windows user signs in if sign-in startup was enabled.' -ForegroundColor Green
    }
    exit 0
} catch {
    Write-Host $_ -ForegroundColor Red
    exit 1
} finally {
    if ($brokerTaskState -and -not $brokerTaskState.Restored) {
        try { Restore-ManagedBrokerAutoStart $brokerTaskState }
        catch { Write-Warning "Could not restore the M9R Web Broker task state: $($_.Exception.Message)" }
    }
    if ($brokerNeedsResume -and $brokerResumeEngine -and (Test-Path -LiteralPath $brokerResumeEngine -PathType Leaf)) {
        try {
            Write-Warning 'The install did not reach its broker restart step; restoring the previously managed broker service.'
            [void](Invoke-ManagedBrokerUpdate $brokerResumeEngine 'start')
        } catch { Write-Warning "Could not restore the managed broker automatically: $($_.Exception.Message)" }
    }
    if ($temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
        Remove-M9rTemporaryDirectory $temporaryRoot
    }
}
