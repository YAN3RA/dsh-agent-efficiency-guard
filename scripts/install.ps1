#Requires -Version 7.0
<#
.SYNOPSIS
    Install or upgrade dsh-agent-efficiency-guard into a DSH profile without npm.

.DESCRIPTION
    Resolves the newest Release asset, then installs it through the DSH
    launcher itself:

        dsh plugin --profile <name> add <asset-url>

    Using the launcher (not a hand-edited package.json plus a bare pnpm install)
    matters. `dsh plugin` runs pnpm inside the profile and afterwards reconciles
    bundle selection: a newly added dependency that declares `dsh.bundle` is
    appended to `dsh.profile.bundles` and its patch files are validated. A plain
    `pnpm install` does neither, so a hand-edited manifest installs the package
    but never mounts it. This script therefore only writes the manifest when the
    launcher is unavailable, and says so loudly.

    Asset names carry a content hash (…-<sha8>.tgz). That is deliberate: pnpm
    caches a tarball by URL + integrity, so overwriting an asset under the same
    name would silently keep installing the old build. A hashed name changes the
    URL whenever the bytes change.

    Idempotent: when the profile already points at the newest asset, pnpm
    reports "Already up to date" and nothing else changes.

.PARAMETER Version
    Install a specific tag (for example v0.1.12) instead of the newest Release.

.PARAMETER Profile
    Profile name under $DSH_HOME/profiles. Defaults to 'desktop'.

.PARAMETER DryRun
    Resolve and report what would change without installing anything.

.PARAMETER Proxy
    HTTP(S) proxy for GitHub and pnpm, for example http://127.0.0.1:7890.

.PARAMETER DshCommand
    Explicit path to dsh.cmd / dsh.ps1, when it is not on PATH and the
    installed Desktop application cannot be located automatically.

.EXAMPLE
    pwsh -NoProfile -File scripts/install.ps1

.EXAMPLE
    pwsh -NoProfile -File scripts/install.ps1 -Proxy http://127.0.0.1:7890

.EXAMPLE
    pwsh -NoProfile -File scripts/install.ps1 -Version v0.1.12 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Profile = 'desktop',
    [switch]$DryRun,
    [string]$Proxy,
    [string]$DshCommand
)

$ErrorActionPreference = 'Stop'
$Repo = 'YAN3RA/dsh-agent-efficiency-guard'
$PackageName = 'dsh-agent-efficiency-guard'
$ExitOk = 0
$ExitFailure = 1

function Write-Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok($Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2($Message) { Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Fail($Message) { Write-Host "    $Message" -ForegroundColor Red }

function Stop-WithError($Message, $Hints) {
    Write-Host ''
    Write-Fail $Message
    if ($null -ne $Hints) {
        foreach ($hint in @($Hints)) { if ($hint) { Write-Host "    -> $hint" -ForegroundColor DarkGray } }
    }
    exit $ExitFailure
}

# --- environment -------------------------------------------------------------

if ($Proxy) {
    $env:HTTPS_PROXY = $Proxy
    $env:HTTP_PROXY = $Proxy
    Write-Ok "using proxy $Proxy"
}

function Get-DshHome {
    if ($env:DSH_HOME) {
        if (-not (Test-Path -LiteralPath $env:DSH_HOME)) {
            Stop-WithError "DSH_HOME points at $env:DSH_HOME, which does not exist." @('Unset DSH_HOME to use the default ~/.dsh, or point it at a real DSH home.')
        }
        return $env:DSH_HOME
    }
    $fallback = Join-Path $HOME '.dsh'
    if (-not (Test-Path -LiteralPath $fallback)) {
        Stop-WithError "Cannot find the DSH home at $fallback." @('Start DSH once so it creates its home, or set DSH_HOME and retry.')
    }
    return $fallback
}

<#
    Locate the dsh launcher. The installed application directory is matched with
    a wildcard on purpose: its leaf name has changed between releases, and a
    hard-coded spelling would break on the next rename.
#>
function Resolve-DshLauncher {
    if ($DshCommand) {
        if (-not (Test-Path -LiteralPath $DshCommand)) {
            Stop-WithError "DshCommand points at $DshCommand, which does not exist." @('Pass the full path to dsh.cmd, for example ...\resources\runtime\cli\bin\dsh.cmd')
        }
        return $DshCommand
    }

    $onPath = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -ne $onPath -and $onPath.Source) { return $onPath.Source }

    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $programs = Join-Path $env:LOCALAPPDATA 'Programs'
        if (Test-Path -LiteralPath $programs) {
            $candidates += Get-ChildItem -LiteralPath $programs -Directory -Filter '*Harness*' -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'resources\runtime\cli\bin\dsh.cmd' }
        }
        $candidates += Join-Path $env:LOCALAPPDATA 'deepseek-harness\bin\dsh.cmd'
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }

    Stop-WithError "Cannot find the dsh launcher." @(
        'Open DSH once, then re-run this script.',
        'Or pass -DshCommand <full path to dsh.cmd>.',
        'The launcher usually lives under %LOCALAPPDATA%\Programs\<install dir>\resources\runtime\cli\bin\dsh.cmd'
    )
}

# --- release resolution ------------------------------------------------------

function Get-Release($ApiUrl) {
    $headers = @{
        'User-Agent' = 'dsh-agent-efficiency-guard-installer'
        'Accept'     = 'application/vnd.github+json'
    }
    try {
        return Invoke-RestMethod -Uri $ApiUrl -Headers $headers -TimeoutSec 60
    } catch {
        Stop-WithError "Cannot read the GitHub release ($ApiUrl)." @(
            "Detail: $($_.Exception.Message)",
            'If your network needs a proxy, re-run with -Proxy http://127.0.0.1:7890',
            "You can also pin a version explicitly: -Version v0.1.13"
        )
    }
}

function Select-Asset($Release) {
    $assets = @($Release.assets | Where-Object { $_.name -like '*.tgz' })
    if ($assets.Count -eq 0) {
        Stop-WithError "Release $($Release.tag_name) has no .tgz asset." @("Publish one with 'node scripts/release.mjs' first.")
    }
    # Prefer the content-hashed asset; fall back to any tgz so an older release still works.
    $hashed = $assets | Where-Object { $_.name -match '-[0-9a-f]{8}\.tgz$' } | Select-Object -First 1
    if ($null -ne $hashed) { return $hashed }
    $fallback = $assets | Select-Object -First 1
    Write-Warn2 "this release has no content-hashed asset; upgrading may hit the pnpm URL cache (see docs/install.md)"
    return $fallback
}

# --- main --------------------------------------------------------------------

$dshHome = Get-DshHome
$profileDir = Join-Path $dshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Stop-WithError "Profile manifest not found: $manifestPath" @("Create the profile by starting DSH once, or check -Profile (currently '$Profile').")
}

Write-Step "resolving release"
$apiUrl = if ($Version) {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
} else {
    "https://api.github.com/repos/$Repo/releases/latest"
}
$release = Get-Release $apiUrl
$asset = Select-Asset $release
$assetUrl = $asset.browser_download_url
Write-Ok "$($release.tag_name) -> $($asset.name)"

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$current = $null
if ($manifest.PSObject.Properties.Name -contains 'dependencies') {
    $dep = $manifest.dependencies.PSObject.Properties[$PackageName]
    if ($null -ne $dep) { $current = $dep.Value }
}
$alreadyPinned = ($current -eq $assetUrl)
$bundleListed = $false
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundleListed = @($manifest.dsh.profile.bundles) -contains $PackageName
}

if ($alreadyPinned) {
    Write-Step "profile already pins $($asset.name)"
} else {
    Write-Step "profile will move to $($asset.name)"
    if ($current) { Write-Ok "from: $current" }
    Write-Ok "to:   $assetUrl"
}
if (-not $bundleListed) {
    Write-Warn2 "dsh.profile.bundles does not list $PackageName yet; the launcher will append it during install."
}

if ($DryRun) {
    Write-Step "dry run"
    Write-Warn2 "nothing was written and pnpm was not run"
    Write-Host ''
    Write-Host "Re-run without -DryRun to install." -ForegroundColor Cyan
    exit $ExitOk
}

$dsh = Resolve-DshLauncher
Write-Ok "launcher: $dsh"

Write-Step "installing through dsh plugin add"
$pnpmArgs = @('plugin', '--profile', $Profile, 'add', $assetUrl)
& $dsh @pnpmArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
    Stop-WithError "dsh plugin add failed (exit $code)." @(
        'If it timed out reaching GitHub, re-run with -Proxy http://127.0.0.1:7890',
        "Full pnpm log: $(Join-Path $profileDir '.plugin-manager\logs')",
        'If it complains about incompatible DSH versions, read the suggested allow-version command it printed.'
    )
}

# --- verification ------------------------------------------------------------

$installedManifest = Join-Path $profileDir "node_modules\$PackageName\package.json"
if (-not (Test-Path -LiteralPath $installedManifest)) {
    Stop-WithError "pnpm reported success but $installedManifest is missing." @(
        'Check the pnpm log under the profile .plugin-manager\logs directory.',
        'Re-run with -DryRun to confirm which asset URL is being requested.'
    )
}
$installed = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
Write-Ok "installed version $($installed.version)"

$after = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pinnedNow = $null
if ($after.PSObject.Properties.Name -contains 'dependencies') {
    $depAfter = $after.dependencies.PSObject.Properties[$PackageName]
    if ($null -ne $depAfter) { $pinnedNow = $depAfter.Value }
}
$listedNow = $false
if ($after.dsh -and $after.dsh.profile -and $after.dsh.profile.bundles) {
    $listedNow = @($after.dsh.profile.bundles) -contains $PackageName
}
if ($pinnedNow) { Write-Ok "profile pins: $pinnedNow" }

if ($listedNow) {
    Write-Ok "dsh.profile.bundles lists $PackageName"
} else {
    Write-Warn2 "dsh.profile.bundles still does not list $PackageName."
    Write-Warn2 "The package is installed but DSH will not mount it. Add `"$PackageName`" to"
    Write-Warn2 "dsh.profile.bundles in $manifestPath and restart DSH."
}

$clientBundle = Join-Path $profileDir "node_modules\$PackageName\lib\client.js"
if (Test-Path -LiteralPath $clientBundle) {
    Write-Ok "client bundle $((Get-Item -LiteralPath $clientBundle).Length) bytes"
}

Write-Step "done"
Write-Host ''
Write-Host "Restart DSH to load the new code." -ForegroundColor Cyan
Write-Host "If the plugin does not appear, check Settings -> Plugins and $manifestPath." -ForegroundColor DarkGray
exit $ExitOk
