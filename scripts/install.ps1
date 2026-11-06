#Requires -Version 7.0
<#
.SYNOPSIS
    Install or upgrade dsh-agent-efficiency-guard into the DSH desktop profile.

.DESCRIPTION
    Resolves the newest Release asset, points the profile dependency at it, runs
    pnpm install, and tells the user to restart DSH.

    Asset names carry a content hash (…-<sha8>.tgz). That is deliberate: pnpm
    caches a tarball by URL + integrity, so overwriting an asset under the same
    name would silently keep installing the old build. A hashed name changes the
    URL whenever the bytes change.

    Idempotent: running it when the profile already points at the newest asset
    re-installs the same bytes and changes nothing else.

.PARAMETER Version
    Install a specific tag (for example v0.1.12) instead of the newest Release.

.PARAMETER Profile
    Profile name under $DSH_HOME/profiles. Defaults to 'desktop'.

.PARAMETER DryRun
    Report what would change without writing anything.

.PARAMETER Proxy
    HTTP(S) proxy for GitHub and pnpm, for example http://127.0.0.1:7890.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Profile = 'desktop',
    [switch]$DryRun,
    [string]$Proxy
)

$ErrorActionPreference = 'Stop'
$Repo = 'YAN3RA/dsh-agent-efficiency-guard'
$PackageName = 'dsh-agent-efficiency-guard'

function Write-Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok($Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2($Message){ Write-Host "    $Message" -ForegroundColor Yellow }

function Get-DshHome {
    if ($env:DSH_HOME -and (Test-Path -LiteralPath $env:DSH_HOME)) { return $env:DSH_HOME }
    $fallback = Join-Path $HOME '.dsh'
    if (-not (Test-Path -LiteralPath $fallback)) {
        throw "Cannot find the DSH home. Set DSH_HOME to your DSH home directory and retry."
    }
    return $fallback
}

function Get-RuntimePath($DshHome, $Leaf, $Exe) {
    $root = Join-Path $DshHome "dsh-runtimes\dsh-primary-runtime\dependencies\$Leaf"
    if (-not (Test-Path -LiteralPath $root)) {
        throw "DSH runtime not found at $root. Start DSH once so it provisions its runtime, then retry."
    }
    $found = Get-ChildItem -LiteralPath $root -Recurse -Filter $Exe -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $found) { throw "Cannot find $Exe under $root." }
    return $found.FullName
}

# GitHub direct access is unreliable on some networks; honour an explicit proxy
# and otherwise let the caller's environment decide.
if ($Proxy) {
    $env:HTTPS_PROXY = $Proxy
    $env:HTTP_PROXY = $Proxy
    Write-Ok "using proxy $Proxy"
}

$dshHome = Get-DshHome
$profileDir = Join-Path $dshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Profile manifest not found: $manifestPath. Create the profile by starting DSH first."
}

Write-Step "resolving release"
$headers = @{ 'User-Agent' = 'dsh-agent-efficiency-guard-installer'; 'Accept' = 'application/vnd.github+json' }
$releaseUrl = if ($Version) {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
} else {
    "https://api.github.com/repos/$Repo/releases/latest"
}
try {
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -TimeoutSec 60
} catch {
    throw "Cannot read the GitHub release ($releaseUrl). If your network needs a proxy, re-run with -Proxy http://127.0.0.1:7890. Detail: $($_.Exception.Message)"
}

# Prefer the hashed asset; fall back to any tgz so an older release still works.
$assets = @($release.assets | Where-Object { $_.name -like '*.tgz' })
if ($assets.Count -eq 0) {
    throw "Release $($release.tag_name) has no .tgz asset. Publish one with 'node scripts/release.mjs' first."
}
$asset = $assets | Where-Object { $_.name -match '-[0-9a-f]{8}\.tgz$' } | Select-Object -First 1
if ($null -eq $asset) {
    $asset = $assets | Select-Object -First 1
    Write-Warn2 "this release has no content-hashed asset; upgrading may hit the pnpm cache (see docs/install.md)"
}
Write-Ok "$($release.tag_name) -> $($asset.name)"

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$current = $manifest.dependencies.$PackageName
if ($current -eq $asset.browser_download_url) {
    Write-Step "already pinned to $($asset.name)"
} else {
    Write-Step "updating profile dependency"
    if ($current) { Write-Ok "from: $current" }
    Write-Ok "to:   $($asset.browser_download_url)"
    if (-not $DryRun) {
        # Edit the parsed object and re-serialize, so unrelated keys survive.
        $manifest.dependencies | Add-Member -NotePropertyName $PackageName `
            -NotePropertyValue $asset.browser_download_url -Force
        $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8
        Write-Ok "wrote $manifestPath"
    }
}

if (-not ($manifest.dsh.profile.bundles -contains $PackageName)) {
    Write-Warn2 "the profile's dsh.profile.bundles does not list $PackageName; DSH will install the package but not mount it."
    Write-Warn2 "add it to dsh.profile.bundles in $manifestPath to activate the plugin."
}

Write-Step "installing"
$node = Get-RuntimePath $dshHome 'node' 'node.exe'
$pnpm = Get-RuntimePath $dshHome 'pnpm' 'pnpm.cjs'
if ($DryRun) {
    Write-Warn2 "dry run: skipping pnpm install"
} else {
    Push-Location $profileDir
    try {
        & $node $pnpm install
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed (exit $LASTEXITCODE). If it timed out reaching GitHub, re-run with -Proxy http://127.0.0.1:7890."
        }
    } finally {
        Pop-Location
    }
}

$installedManifest = Join-Path $profileDir "node_modules\$PackageName\package.json"
if (Test-Path -LiteralPath $installedManifest) {
    $installed = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
    Write-Ok "installed version $($installed.version)"
    $bundle = Join-Path $profileDir "node_modules\$PackageName\lib\client.js"
    if (Test-Path -LiteralPath $bundle) {
        $size = (Get-Item -LiteralPath $bundle).Length
        Write-Ok "client bundle $size bytes"
    }
}

Write-Step "done"
Write-Host ""
Write-Host "Restart DSH to load the new code." -ForegroundColor Cyan
Write-Host "If the plugin does not appear, check Settings -> Plugins and $manifestPath." -ForegroundColor DarkGray
