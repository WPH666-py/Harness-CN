# Build the Harness-CN Windows x64 installer from this repository.
#
#   powershell -File build-harness-cn.ps1                 # includes `pnpm install`
#   powershell -File build-harness-cn.ps1 -SkipInstall    # node_modules is already populated
#
# Prerequisites: Windows x64, Node 22.19+ or 24+, git, pnpm 11.7.0 on PATH (the repository
# pins that version in package.json), and a real Python only when a native module has to be
# compiled from source (node-pty and koffi ship prebuilds, so usually no Python is needed).
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a script without a BOM as ANSI, so a
# non-ASCII byte in this file breaks parsing there.
[CmdletBinding()]
param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$RepoRoot     = $PSScriptRoot
$ArtifactsDir = Join-Path $RepoRoot 'apps\desktop\.desktop-build\targets\win-x64\artifacts'
$LogFile      = Join-Path $RepoRoot 'build.log'
$IconPath     = Join-Path $RepoRoot 'apps\desktop\build\icon.ico'

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

Assert-Command node
Assert-Command git
Assert-Command pnpm

$pnpmVersion = ((Get-Content (Join-Path $RepoRoot 'package.json') -Raw) | ConvertFrom-Json).packageManager
Write-Host "pnpm:    $(& pnpm --version)  (repository pins $pnpmVersion)"

# --- Release identity and packaging environment ------------------------------

# The fork's own application identity, and the unsigned path that skips the EV certificate,
# the SafeNet token, and the updater origin. Upstream 0.1.5-rc.1 has no unsigned mode of its
# own; this fork adds one, so a build needs no signing material.
$env:DSH_DESKTOP_APP_ID = 'com.harnesscn.desktop'
$env:DSH_DESKTOP_UNSIGNED = '1'

# electron-builder fetches Electron and its NSIS toolchain from GitHub, which is slow enough in
# some networks to hit its ten-minute request timeout. The mirrors serve the same artifacts;
# delete these two lines if the direct download works for you.
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# Native modules build through node-gyp; the Windows Store python.exe is a zero-byte reparse
# point that cannot build anything, so resolve the launcher's real interpreter when there is one.
$python = $null
foreach ($selector in @('-3.13', '-3.12', '-3.11', '-3')) {
  try { $python = (py $selector -c "import sys; print(sys.executable)" 2>$null) } catch { }
  if ($python) { break }
}
if ($python -and (Test-Path $python)) {
  $env:PYTHON = $python
  Write-Host "Python:  $python"
} else {
  Write-Warning 'No real Python found via the py launcher; a native module that needs an own build will fail.'
}

if (-not (Test-Path $IconPath)) {
  throw "Application icon not found at $IconPath. Generate it from Harness.ico into apps/desktop/build/icon.ico."
}

# --- Build -------------------------------------------------------------------

Push-Location $RepoRoot
try {
  if (-not $SkipInstall) {
    Write-Host '=== pnpm install ===' -ForegroundColor Cyan
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  }

  Write-Host '=== pnpm run package:desktop:win:x64 ===' -ForegroundColor Cyan
  Write-Host '(build:official, release:pack, prepare:runtime, prepare:seed, electron-builder)'
  Write-Host ''

  & pnpm run package:desktop:win:x64 2>&1 | Tee-Object -FilePath $LogFile
  if ($LASTEXITCODE -ne 0) { throw "Packaging failed with exit code $LASTEXITCODE. See $LogFile" }
}
finally {
  Pop-Location
}

# --- Report ------------------------------------------------------------------

Write-Host ''
Write-Host '=== Build complete ===' -ForegroundColor Green
if (Test-Path $ArtifactsDir) {
  Get-ChildItem $ArtifactsDir |
    Where-Object { $_.Extension -in '.exe', '.blockmap' } |
    Select-Object Name, @{ n = 'SizeMB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime |
    Format-Table -AutoSize
  Write-Host "Artifacts: $ArtifactsDir"
  Write-Host ''
  Write-Host 'The installer is unsigned, so Windows SmartScreen warns on first run.'
  Write-Host 'Publish it as a GitHub release asset: GitHub caps repository files at 100 MB and it is larger.'
} else {
  Write-Warning "Expected artifact directory was not created: $ArtifactsDir"
}
