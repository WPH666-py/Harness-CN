# Build the Harness-CN Windows x64 installer for the Tauri shell.
#
#   powershell -File build-harness-cn-tauri.ps1                 # full build
#   powershell -File build-harness-cn-tauri.ps1 -SkipPrepare    # resources are already staged
#
# The two halves of this build belong to different packages, and the order between them matters:
#
#   1. `@deepseek-ai/dsh-desktop` prepares the shared payload — the bundled Node and pnpm runtime,
#      the local first-party tarballs, and the seed: the pre-installed profile the first launch
#      links from the store. This is the same pipeline the Electron build used, unchanged.
#   2. `@deepseek-ai/dsh-desktop-shell` bundles the Node sidecar, stages the runtime, seed, and
#      shell pages under `src-tauri/resources`, and runs `tauri build` to produce the installer.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a script without a BOM as ANSI, so a
# non-ASCII byte in this file breaks parsing there.
[CmdletBinding()]
param(
  [switch]$SkipPrepare
)

$ErrorActionPreference = 'Stop'

$RepoRoot     = $PSScriptRoot
$TauriRoot    = Join-Path $RepoRoot 'apps\desktop-shell\src-tauri'
$ArtifactsDir = Join-Path $TauriRoot 'target\release\bundle\nsis'
$LogFile      = Join-Path $RepoRoot 'build-tauri.log'
$IconPath     = Join-Path $RepoRoot 'Harness.ico'

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

Assert-Command node
Assert-Command cargo
Assert-Command pnpm

# --- Release identity and packaging environment ------------------------------
#
# The fork's own application identity. `DSH_DESKTOP_UNSIGNED=1` selects the unsigned path that
# skips the EV certificate, the SafeNet token, and the updater origin; upstream 0.1.5-rc.1 has no
# unsigned mode of its own, so this fork adds one and a build needs no signing material.
$env:DSH_DESKTOP_APP_ID = 'com.harnesscn.desktop'
$env:DSH_DESKTOP_UNSIGNED = '1'
if (-not (Test-Path $IconPath)) {
  throw "Application icon not found at $IconPath."
}

if ($SkipPrepare) {
  Write-Host 'Skipping the shared payload preparation' -ForegroundColor Yellow
} else {
  Write-Host '=== pnpm --filter @deepseek-ai/dsh-desktop run prepare:package ===' -ForegroundColor Cyan
  Write-Host '(build:official, release:pack, prepare:runtime, prepare:packages, prepare:seed)'
  & pnpm --filter '@deepseek-ai/dsh-desktop' run prepare:package 2>&1 | Tee-Object -FilePath $LogFile
  if ($LASTEXITCODE -ne 0) { throw "Payload preparation failed with exit code $LASTEXITCODE. See $LogFile" }
}

Write-Host ''
Write-Host '=== pnpm --filter @deepseek-ai/dsh-desktop-shell run build ===' -ForegroundColor Cyan
Write-Host '(build:sidecar, prepare:shell, tauri build)'
& pnpm --filter '@deepseek-ai/dsh-desktop-shell' run build 2>&1 | Tee-Object -FilePath $LogFile -Append
if ($LASTEXITCODE -ne 0) { throw "Tauri packaging failed with exit code $LASTEXITCODE. See $LogFile" }

# --- Report ------------------------------------------------------------------

Write-Host ''
Write-Host '=== Build complete ===' -ForegroundColor Green
if (Test-Path $ArtifactsDir) {
  Get-ChildItem $ArtifactsDir -Filter '*.exe' |
    Select-Object Name, @{ n = 'SizeMB'; e = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
    Format-Table -AutoSize
  Write-Host "Artifacts: $ArtifactsDir"
  Write-Host ''
  Write-Host 'The installer is unsigned, so Windows SmartScreen warns on first run.'
} else {
  Write-Warning "Expected artifact directory was not created: $ArtifactsDir"
}
